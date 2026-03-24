import type { NextFunction, RequestHandler } from "express";

export function asyncHandler<THandler extends RequestHandler>(handler: THandler): RequestHandler {
  return (request, response, next: NextFunction) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}
