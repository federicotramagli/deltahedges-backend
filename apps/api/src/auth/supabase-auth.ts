import type { NextFunction, RequestHandler, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { config } from "../config.js";
import type { AuthedRequest } from "../types/http.js";

const supabase = createClient(
  config.SUPABASE_URL,
  config.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

export const requireAuth: RequestHandler = (
  request,
  response: Response,
  next: NextFunction,
) => {
  const authorization = request.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length);
    void supabase.auth
      .getUser(token)
      .then(({ data, error }) => {
        if (error || !data.user) {
          if (config.NODE_ENV !== "production" && config.DEV_USER_ID) {
            request.auth = { userId: config.DEV_USER_ID };
            next();
            return;
          }

          response.status(401).json({ error: "Invalid Supabase session" });
          return;
        }

        request.auth = {
          userId: data.user.id,
          email: data.user.email,
        };
        next();
      })
      .catch(next);
    return;
  }

  if (config.NODE_ENV !== "production" && config.DEV_USER_ID) {
    request.auth = { userId: config.DEV_USER_ID };
    next();
    return;
  }

  response.status(401).json({ error: "Missing bearer token" });
};
