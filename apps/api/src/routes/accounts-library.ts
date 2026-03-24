import { Router } from "express";
import { savedAccountSchema } from "@deltahedge/shared";
import { requireAuth } from "../auth/supabase-auth.js";
import type { AuthedRequest } from "../types/http.js";
import {
  createSavedAccount,
  listSavedAccountsForUser,
} from "../services/account-library-service.js";

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
  void createSavedAccount(authedRequest.auth.userId, body)
    .then((account) => {
      response.status(201).json({ account });
    })
    .catch(next);
});
