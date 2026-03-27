import { Queue } from "bullmq";
import { config } from "../config.js";

const redisUrl = new URL(config.REDIS_URL);

export const connection = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  username: redisUrl.username || undefined,
  password: redisUrl.password || undefined,
  db: redisUrl.pathname ? Number(redisUrl.pathname.replace("/", "") || 0) : 0,
  maxRetriesPerRequest: null,
};

export const queues = {
  dailyPlanner: new Queue("deltahedge-daily-planner", { connection }),
  slotEntry: new Queue("deltahedge-slot-entry", { connection }),
  slotForcedClose: new Queue("deltahedge-slot-forced-close", { connection }),
  slotMonitor: new Queue("deltahedge-slot-monitor", { connection }),
};
