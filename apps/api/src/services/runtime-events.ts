import { Redis } from "ioredis";
import type { RuntimeEvent } from "@deltahedge/shared";
import { runtimeChannels } from "@deltahedge/shared";
import { config } from "../config.js";

const publisher = config.REDIS_URL
  ? new Redis(config.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 500,
    })
  : null;

publisher?.on("error", () => {});

export async function publishRuntimeEvent(event: RuntimeEvent) {
  if (!publisher) return;
  try {
    if (publisher.status === "wait") {
      await publisher.connect();
    }

    if (publisher.status !== "ready" && publisher.status !== "connect") {
      return;
    }

    await publisher.publish(runtimeChannels.events, JSON.stringify(event));
  } catch {
    // Realtime events are optional during local development.
  }
}
