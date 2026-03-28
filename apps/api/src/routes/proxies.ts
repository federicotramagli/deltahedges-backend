import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/supabase-auth.js";
import { adminEmails } from "../config.js";
import type { AuthedRequest } from "../types/http.js";
import {
  assignDedicatedProxyForUser,
  assignSpecificProxyToUser,
  listProxyInventory,
  releaseProxyForUser,
  upsertProxyInventoryEntry,
  type ProxyPoolUpsertInput,
} from "../services/proxy-service.js";
import { verifyProxyInventoryEntry } from "../services/proxy-verification-service.js";
import { getUserIdByEmail } from "../services/supabase-admin-service.js";
import { pool } from "../db/pool.js";

const proxyUpsertSchema = z.object({
  id: z.string().uuid().optional(),
  ipAddress: z.string().trim().optional(),
  countryCode: z.string().trim().min(2).max(2),
  provider: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.coerce.number().int().positive().max(65535).nullable().optional(),
  protocol: z.enum(["http", "https", "socks5"]).default("http"),
  username: z.string().trim().optional().default(""),
  password: z.string().trim().optional().default(""),
  stickySessionKey: z.string().trim().optional().default(""),
  stickySessionTtlMinutes: z.coerce.number().int().min(1).max(1440).default(60),
  providerReference: z.string().trim().optional().default(""),
  notes: z.string().trim().optional().default(""),
  status: z.enum(["AVAILABLE", "IN_USE", "DISABLED"]).default("AVAILABLE"),
});

const proxyImportSchema = z.object({
  proxies: z.array(proxyUpsertSchema).min(1),
});

const proxyVerificationSchema = z.object({
  endpointUrl: z.string().url(),
  expectedCountryCode: z.string().trim().min(2).max(2).optional(),
  userId: z.string().uuid().optional().nullable(),
});

const proxyAssignmentSchema = z
  .object({
    proxyId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    email: z.string().trim().email().optional(),
    billingCountry: z.string().trim().min(2).max(2).optional(),
    metaapiRegion: z.string().trim().min(1).optional(),
    verifyEndpointUrl: z.string().url().optional(),
    expectedCountryCode: z.string().trim().min(2).max(2).optional(),
  })
  .refine((value) => Boolean(value.userId || value.email), {
    message: "Provide userId or email",
    path: ["userId"],
  });

const proxyReleaseSchema = z
  .object({
    userId: z.string().uuid().optional(),
    email: z.string().trim().email().optional(),
  })
  .refine((value) => Boolean(value.userId || value.email), {
    message: "Provide userId or email",
    path: ["userId"],
  });

export const proxiesRouter = Router();
proxiesRouter.use(requireAuth);

proxiesRouter.use((request, response, next) => {
  const authedRequest = request as AuthedRequest;
  const normalizedEmail = authedRequest.auth.email?.trim().toLowerCase() ?? "";

  if (!adminEmails.has(normalizedEmail)) {
    response.status(403).json({
      error: "Solo l'admin puo gestire i proxy residenziali.",
    });
    return;
  }

  next();
});

function toProxyUpsertInput(body: z.infer<typeof proxyUpsertSchema>): ProxyPoolUpsertInput {
  return {
    id: body.id,
    ipAddress: body.ipAddress,
    countryCode: body.countryCode,
    provider: body.provider,
    host: body.host,
    port: body.port ?? null,
    protocol: body.protocol,
    username: body.username || undefined,
    password: body.password || undefined,
    stickySessionKey: body.stickySessionKey || undefined,
    stickySessionTtlMinutes: body.stickySessionTtlMinutes,
    providerReference: body.providerReference || undefined,
    notes: body.notes || undefined,
    status: body.status,
  };
}

async function resolveTargetUser(body: {
  userId?: string;
  email?: string;
}) {
  if (body.userId) {
    return {
      userId: body.userId,
      email: body.email?.trim().toLowerCase() ?? null,
    };
  }

  if (!body.email) {
    throw new Error("Missing target user");
  }

  return {
    userId: await getUserIdByEmail(body.email),
    email: body.email.trim().toLowerCase(),
  };
}

proxiesRouter.get("/", (_request, response, next) => {
  void listProxyInventory()
    .then((proxies) => {
      response.json({ proxies });
    })
    .catch(next);
});

proxiesRouter.post("/", (request, response, next) => {
  const body = proxyUpsertSchema.parse(request.body);

  void upsertProxyInventoryEntry(toProxyUpsertInput(body))
    .then((proxy) => {
      response.status(body.id ? 200 : 201).json({ proxy });
    })
    .catch(next);
});

proxiesRouter.post("/import", (request, response, next) => {
  const body = proxyImportSchema.parse(request.body);

  void Promise.all(body.proxies.map((proxy) => upsertProxyInventoryEntry(toProxyUpsertInput(proxy))))
    .then((proxies) => {
      response.status(201).json({ proxies, imported: proxies.length });
    })
    .catch(next);
});

proxiesRouter.post("/:proxyId/verify", (request, response, next) => {
  const authedRequest = request as AuthedRequest<unknown, { proxyId: string }>;
  const body = proxyVerificationSchema.parse(request.body);

  void verifyProxyInventoryEntry({
    proxyId: authedRequest.params.proxyId,
    endpointUrl: body.endpointUrl,
    expectedCountryCode: body.expectedCountryCode,
    userId: body.userId ?? authedRequest.auth.userId,
  })
    .then((verification) => {
      response.json({ verification });
    })
    .catch(next);
});

proxiesRouter.post("/assign", (request, response, next) => {
  const body = proxyAssignmentSchema.parse(request.body);

  void resolveTargetUser(body)
    .then(async (target) => {
      const client = await pool.connect();
      try {
        await client.query("begin");

        const proxy = body.proxyId
          ? await assignSpecificProxyToUser({
              proxyId: body.proxyId,
              userId: target.userId,
              billingCountry: body.billingCountry,
              metaapiRegion: body.metaapiRegion,
              queryable: client,
            })
          : await assignDedicatedProxyForUser({
              client,
              userId: target.userId,
              billingCountry: body.billingCountry,
            });

        await client.query("commit");

        const verification = body.verifyEndpointUrl
          ? await verifyProxyInventoryEntry({
              proxyId: proxy.id,
              endpointUrl: body.verifyEndpointUrl,
              expectedCountryCode: body.expectedCountryCode,
              userId: target.userId,
            })
          : null;

        response.json({
          userId: target.userId,
          email: target.email,
          proxy,
          verification,
        });
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    })
    .catch(next);
});

proxiesRouter.post("/release", (request, response, next) => {
  const body = proxyReleaseSchema.parse(request.body);

  void resolveTargetUser(body)
    .then(async (target) => {
      await releaseProxyForUser(target.userId);
      response.json({
        released: true,
        userId: target.userId,
        email: target.email,
      });
    })
    .catch(next);
});
