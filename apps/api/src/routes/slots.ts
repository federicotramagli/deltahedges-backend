import { Router } from "express";
import {
  activateSlotSchema,
  createSlotSchema,
  slotAccountsSchema,
  slotParametersSchema,
} from "@deltahedge/shared";
import { requireAuth } from "../auth/supabase-auth.js";
import { adminEmails } from "../config.js";
import type { AuthedRequest } from "../types/http.js";
import {
  activateSlot,
  createSlot,
  getSlotById,
  listSlotsForUser,
  listTradesForSlot,
  pauseSlot,
  upsertSlotAccounts,
  upsertSlotParameters,
} from "../services/slot-service.js";
import { deleteSlotForUser } from "../services/resource-delete-service.js";

export const slotsRouter = Router();
const activeSlotAccountSyncs = new Set<string>();

slotsRouter.use(requireAuth);

slotsRouter.get("/", (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  void listSlotsForUser(authedRequest.auth.userId)
    .then((payload) => {
      response.json(payload);
    })
    .catch(next);
});

slotsRouter.post("/", (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  const body = createSlotSchema.parse(request.body);
  void createSlot(authedRequest.auth.userId, body)
    .then((slot) => {
      response.status(201).json({ slot });
    })
    .catch(next);
});

slotsRouter.get("/:slotId", (request, response, next) => {
  const authedRequest = request as AuthedRequest<unknown, { slotId: string }>;
  void getSlotById(authedRequest.auth.userId, authedRequest.params.slotId)
    .then((slot) => {
      response.json({ slot });
    })
    .catch(next);
});

slotsRouter.post("/:slotId/accounts", (request, response, next) => {
  const authedRequest = request as AuthedRequest<unknown, { slotId: string }>;
  const body = slotAccountsSchema.parse(request.body);
  const lockKey = `${authedRequest.auth.userId}:${authedRequest.params.slotId}`;

  if (activeSlotAccountSyncs.has(lockKey)) {
    response.status(409).json({
      error: "Connection sync already running for this slot",
    });
    return;
  }

  activeSlotAccountSyncs.add(lockKey);
  void upsertSlotAccounts(authedRequest.auth.userId, authedRequest.params.slotId, body, {
    email: authedRequest.auth.email,
  })
    .then((slot) => {
      response.json({ slot });
    })
    .catch(next)
    .finally(() => {
      activeSlotAccountSyncs.delete(lockKey);
    });
});

slotsRouter.post("/:slotId/parameters", (request, response, next) => {
  const authedRequest = request as AuthedRequest<unknown, { slotId: string }>;
  const body = slotParametersSchema.parse(request.body);
  void upsertSlotParameters(authedRequest.auth.userId, authedRequest.params.slotId, body)
    .then((slot) => {
      response.json({ slot });
    })
    .catch(next);
});

slotsRouter.post("/:slotId/activate", (request, response, next) => {
  const authedRequest = request as AuthedRequest<unknown, { slotId: string }>;
  const body = activateSlotSchema.parse(request.body);
  void activateSlot(authedRequest.auth.userId, authedRequest.params.slotId, body.phase)
    .then((slot) => {
      response.json({ slot });
    })
    .catch(next);
});

slotsRouter.post("/:slotId/pause", (request, response, next) => {
  const authedRequest = request as AuthedRequest<unknown, { slotId: string }>;
  void pauseSlot(authedRequest.auth.userId, authedRequest.params.slotId, false)
    .then((slot) => {
      response.json({ slot });
    })
    .catch(next);
});

slotsRouter.get("/:slotId/trades", (request, response, next) => {
  const authedRequest = request as AuthedRequest<unknown, { slotId: string }>;
  void listTradesForSlot(authedRequest.auth.userId, authedRequest.params.slotId)
    .then((trades) => {
      response.json({ trades });
    })
    .catch(next);
});

slotsRouter.delete("/:slotId", (request, response, next) => {
  const authedRequest = request as AuthedRequest<unknown, { slotId: string }>;
  const normalizedEmail = authedRequest.auth.email?.trim().toLowerCase() ?? "";

  if (!adminEmails.has(normalizedEmail)) {
    response.status(403).json({
      error: "Solo l'admin puo eliminare le card slot.",
    });
    return;
  }

  void deleteSlotForUser(authedRequest.auth.userId, authedRequest.params.slotId)
    .then((deletedSlot) => {
      response.json({ deletedSlot });
    })
    .catch(next);
});
