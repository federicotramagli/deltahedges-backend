import express, { Router } from "express";
import { requireAuth } from "../auth/supabase-auth.js";
import type { AuthedRequest } from "../types/http.js";
import { createCheckoutSession, handleStripeWebhook } from "../services/stripe-service.js";

export const stripeRouter = Router();
export const stripeWebhookRouter = Router();

stripeRouter.use(requireAuth);

stripeRouter.post("/create-checkout-session", (request, response, next) => {
  const authedRequest = request as AuthedRequest<{ quantity?: number | string }>;
  const quantity = Math.max(1, Number(authedRequest.body?.quantity ?? 1));
  void createCheckoutSession(authedRequest.auth.userId, quantity)
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
