import { Router } from "express";
import { requireAuth } from "../auth/supabase-auth.js";
import type { AuthedRequest } from "../types/http.js";
import { getPerformance } from "../services/slot-service.js";

export const performanceRouter = Router();

performanceRouter.use(requireAuth);

performanceRouter.get("/", (request, response, next) => {
  const authedRequest = request as AuthedRequest;
  void getPerformance(authedRequest.auth.userId)
    .then((cycleLogs) => {
      response.json({ cycleLogs });
    })
    .catch(next);
});
