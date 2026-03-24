import type { Request } from "express";

export interface AuthContext {
  userId: string;
  email?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    auth?: AuthContext;
  }
}

export type AuthedRequest<TBody = unknown, TParams = Record<string, string>> = Request<
  TParams,
  unknown,
  TBody
> & {
  auth: AuthContext;
};
