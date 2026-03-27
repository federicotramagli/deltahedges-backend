import { Worker } from "bullmq";
import { config } from "./config.js";
import { logger } from "./services/logger.js";
import { connection, queues } from "./services/queues.js";
import { processDailyPlanner } from "./jobs/daily-planner-job.js";
import { processSlotEntry } from "./jobs/slot-entry-job.js";
import { processForcedClose } from "./jobs/slot-forced-close-job.js";

new Worker("deltahedge-daily-planner", processDailyPlanner, {
  connection,
  concurrency: 1,
});

new Worker("deltahedge-slot-entry", processSlotEntry, {
  connection,
  concurrency: config.WORKER_CONCURRENCY,
});

new Worker("deltahedge-slot-forced-close", processForcedClose, {
  connection,
  concurrency: config.WORKER_CONCURRENCY,
});

await queues.dailyPlanner.add(
  "daily-planner",
  { dateKey: new Date().toISOString().slice(0, 10) },
  {
    repeat: {
      pattern: "5 0 * * *",
      tz: "Europe/Rome",
    },
    jobId: "deltahedge-daily-planner",
  },
);

logger.info("DeltaHedge worker online");
