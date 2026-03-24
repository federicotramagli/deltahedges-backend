import { Redis } from "ioredis";
import { runtimeChannels, type RuntimeEvent } from "@deltahedge/shared";
import { config } from "../config.js";

const publisher = new Redis(config.REDIS_URL);

export async function publishRuntimeEvent(event: RuntimeEvent) {
  await publisher.publish(runtimeChannels.events, JSON.stringify(event));
}
