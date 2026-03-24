import { createServer } from "node:http";
import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { logger } from "./logger.js";
import { createApp } from "./app.js";
import { attachRuntimeGateway } from "./websocket/gateway.js";

const app = createApp();
const server = createServer(app);

attachRuntimeGateway(server);

server.listen(config.API_PORT, () => {
  logger.info({ port: config.API_PORT }, "DeltaHedge API listening");
});

process.on("SIGINT", async () => {
  await pool.end();
  server.close(() => process.exit(0));
});
