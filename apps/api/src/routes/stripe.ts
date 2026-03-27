import express, { Router } from "express";
import { requireAuth } from "../auth/supabase-auth.js";
import type { AuthedRequest } from "../types/http.js";
import {
  createCheckoutSession,
  getStripePlans,
  handleStripeWebhook,
} from "../services/stripe-service.js";

export const stripeRouter = Router();
export const stripeWebhookRouter = Router();

stripeRouter.use(requireAuth);

stripeRouter.get("/plans", (_request, response) => {
  response.json(getStripePlans());
});

stripeRouter.post("/create-checkout-session", (request, response, next) => {
  const authedRequest = request as AuthedRequest<{ planId?: string }>;
  const planId = String(authedRequest.body?.planId ?? "").trim();
  void createCheckoutSession(authedRequest.auth.userId, planId)
    .then((session) => {
      response.json({ url: session.url, id: session.id });
    })
    .catch(next);
});

stripeWebhookRouter.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (request, response, next) => {
    void handleStripeWebhook(request.body as Buffer, request.header("stripe-signature"))
      .then((result) => {
        response.json(result);
      })
      .catch(next);
  },
);
