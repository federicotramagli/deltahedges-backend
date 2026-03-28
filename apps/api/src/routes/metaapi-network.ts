import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/supabase-auth.js";
import { adminEmails } from "../config.js";
import type { AuthedRequest } from "../types/http.js";
import {
  getMetaApiUserNetworkSnapshot,
  upsertMetaApiUserNetworkPolicy,
} from "../services/metaapi-network-service.js";
import { reconcileMetaApiDedicatedIpForUser } from "../services/metaapi-network-reconcile-service.js";
import { getUserIdByEmail } from "../services/supabase-admin-service.js";

const networkPolicySchema = z
  .object({
    dedicatedIpRequired: z.coerce.boolean(),
    dedicatedIpFamily: z.enum(["ipv4"]).optional(),
    preferredRegion: z.string().trim().min(1).optional(),
    userId: z.string().uuid().optional(),
    email: z.string().trim().email().optional(),
  })
  .refine((value) => !(value.userId && value.email), {
    message: "Provide either userId or email, not both",
    path: ["userId"],
  });

const networkReconcileSchema = z
  .object({
    userId: z.string().uuid().optional(),
    email: z.string().trim().email().optional(),
    waitUntilReady: z.coerce.boolean().optional().default(true),
    dedicatedIpRequired: z.coerce.boolean().optional(),
    dedicatedIpFamily: z.enum(["ipv4"]).optional(),
    preferredRegion: z.string().trim().min(1).optional(),
  })
  .refine((value) => !(value.userId && value.email), {
    message: "Provide either userId or email, not both",
    path: ["userId"],
  });

export const metaApiNetworkRouter = Router();
metaApiNetworkRouter.use(requireAuth);

async function resolveTargetUser(request: AuthedRequest, body?: { userId?: string; email?: string }) {
  const normalizedEmail = request.auth.email?.trim().toLowerCase() ?? "";
  const isAdmin = adminEmails.has(normalizedEmail);

  if (!body?.userId && !body?.email) {
    return {
      userId: request.auth.userId,
      email: normalizedEmail || null,
    };
  }

  if (!isAdmin) {
    throw new Error("Solo l'admin puo gestire la policy MetaApi di altri utenti.");
  }

  if (body.userId) {
    return {
      userId: body.userId,
      email: body.email?.trim().toLowerCase() ?? null,
    };
  }

  return {
    userId: await getUserIdByEmail(body.email!),
    email: body.email!.trim().toLowerCase(),
  };
}

metaApiNetworkRouter.get("/", (request, response, next) => {
  const authedRequest = request as AuthedRequest;

  void resolveTargetUser(authedRequest)
    .then((target) => getMetaApiUserNetworkSnapshot(target.userId))
    .then((snapshot) => {
      response.json({ snapshot });
    })
    .catch(next);
});

metaApiNetworkRouter.put("/policy", (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  const body = networkPolicySchema.parse(request.body);

  void resolveTargetUser(authedRequest, body)
    .then((target) =>
      upsertMetaApiUserNetworkPolicy({
        userId: target.userId,
        dedicatedIpRequired: body.dedicatedIpRequired,
        dedicatedIpFamily: body.dedicatedIpFamily,
        preferredRegion: body.preferredRegion,
      }),
    )
    .then((policy) => {
      response.json({ policy });
    })
    .catch(next);
});

metaApiNetworkRouter.post("/reconcile", (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  const body = networkReconcileSchema.parse(request.body);

  void resolveTargetUser(authedRequest, body)
    .then(async (target) => {
      if (body.dedicatedIpRequired !== undefined) {
        await upsertMetaApiUserNetworkPolicy({
          userId: target.userId,
          dedicatedIpRequired: body.dedicatedIpRequired,
          dedicatedIpFamily: body.dedicatedIpFamily,
          preferredRegion: body.preferredRegion,
        });
      }

      return reconcileMetaApiDedicatedIpForUser(target.userId, {
        waitUntilReady: body.waitUntilReady,
      });
    })
    .then((results) => {
      response.json({
        results,
        reconciled: results.length,
        failed: results.filter((item) => item.error).length,
      });
    })
    .catch(next);
});
