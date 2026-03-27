import { Router } from "express";
import { savedAccountSchema } from "@deltahedge/shared";
import { requireAuth } from "../auth/supabase-auth.js";
import { adminEmails } from "../config.js";
import type { AuthedRequest } from "../types/http.js";
import {
  createSavedAccount,
  listSavedAccountsForUser,
} from "../services/account-library-service.js";
import { deleteSavedAccountForUser } from "../services/resource-delete-service.js";

export const accountsLibraryRouter = Router();

accountsLibraryRouter.use(requireAuth);

accountsLibraryRouter.get("/", (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  void listSavedAccountsForUser(authedRequest.auth.userId)
    .then((accounts) => {
      response.json({ accounts });
    })
    .catch(next);
});

accountsLibraryRouter.post("/", (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  const body = savedAccountSchema.parse(request.body);
  void createSavedAccount(authedRequest.auth.userId, body, {
    email: authedRequest.auth.email,
  })
    .then((account) => {
      response.status(201).json({ account });
    })
    .catch(next);
});

accountsLibraryRouter.delete("/:accountId", (request, response, next) => {
  const authedRequest = request as AuthedRequest<unknown, { accountId: string }>;
  const normalizedEmail = authedRequest.auth.email?.trim().toLowerCase() ?? "";

  if (!adminEmails.has(normalizedEmail)) {
    response.status(403).json({
      error: "Solo l'admin puo eliminare i conti dalla libreria.",
    });
    return;
  }

  void deleteSavedAccountForUser(authedRequest.auth.userId, authedRequest.params.accountId)
    .then((deletedAccount) => {
      response.json({ deletedAccount });
    })
    .catch(next);
});
