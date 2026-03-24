import type { Server as HttpServer } from "node:http";
import { Redis } from "ioredis";
import { WebSocketServer } from "ws";
import { runtimeChannels, type RuntimeEvent } from "@deltahedge/shared";
import { config } from "../config.js";

export function attachRuntimeGateway(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const subscriber = config.REDIS_URL ? new Redis(config.REDIS_URL) : null;

  subscriber?.on("error", () => {});

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/ws", "http://localhost");
    const userId =
      url.searchParams.get("userId") ??
      (config.NODE_ENV !== "production" ? config.DEV_USER_ID ?? null : null);

    if (!userId) {
      socket.close();
      return;
    }

    socket.send(
      JSON.stringify({
        event: "ws.connected",
        userId,
        emittedAt: new Date().toISOString(),
      }),
    );

    if (subscriber) {
      void subscriber.subscribe(runtimeChannels.events);
      subscriber.on("message", (channel: string, message: string) => {
        if (channel !== runtimeChannels.events) return;
        const payload = JSON.parse(message) as RuntimeEvent;
        if (payload.userId === userId && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify(payload));
        }
      });
    }
  });
}
