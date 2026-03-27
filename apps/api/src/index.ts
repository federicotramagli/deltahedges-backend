import { createServer } from "node:http";
import { config } from "./config.js";
import { ensureDatabaseCompatibility } from "./db/compatibility.js";
import { pool } from "./db/pool.js";
import { logger } from "./logger.js";
import { createApp } from "./app.js";
import { attachRuntimeGateway } from "./websocket/gateway.js";

const app = createApp();
const server = createServer(app);

attachRuntimeGateway(server);

server.listen(config.API_PORT, "0.0.0.0", () => {
  logger.info(
    {
      configuredPort: config.API_PORT,
      envPort: process.env.PORT ?? null,
      envApiPort: process.env.API_PORT ?? null,
      address: server.address(),
    },
    "DeltaHedge API listening",
  );
});

void ensureDatabaseCompatibility();

process.on("SIGINT", async () => {
  await pool.end();
  server.close(() => process.exit(0));
});
