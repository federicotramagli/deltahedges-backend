import cors from "cors";
import express from "express";
import { config, isAllowedFrontendOrigin } from "./config.js";
import { logger } from "./logger.js";
import { healthRouter } from "./routes/health.js";
import { performanceRouter } from "./routes/performance.js";
import { slotsRouter } from "./routes/slots.js";
import { stripeRouter, stripeWebhookRouter } from "./routes/stripe.js";
import { debugRouter } from "./routes/debug.js";
import { accountsLibraryRouter } from "./routes/accounts-library.js";
import { proxiesRouter } from "./routes/proxies.js";
import { metaApiNetworkRouter } from "./routes/metaapi-network.js";

export function createApp() {
  const app = express();

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          callback(null, true);
          return;
        }

        if (isAllowedFrontendOrigin(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`Origin not allowed by CORS: ${origin}`));
      },
      credentials: true,
    }),
  );
  app.use((request, _response, next) => {
    logger.info({ method: request.method, path: request.path }, "incoming request");
    next();
  });

  app.use("/stripe", stripeWebhookRouter);
  app.use(express.json());

  app.get("/", (_request, response) => {
    response.json({ ok: true, service: "deltahedge-api", path: "/" });
  });
  app.use("/health", healthRouter);
  app.use("/debug", debugRouter);
  app.use("/accounts-library", accountsLibraryRouter);
  app.use("/metaapi-network", metaApiNetworkRouter);
  app.use("/proxies", proxiesRouter);
  app.use("/slots", slotsRouter);
  app.use("/performance", performanceRouter);
  app.use("/stripe", stripeRouter);

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction,
    ) => {
      logger.error({ error }, "Unhandled API error");

      if (error instanceof Error) {
        response.status(400).json({ error: error.message });
        return;
      }

      response.status(500).json({ error: "Internal server error" });
    },
  );

  return app;
}
