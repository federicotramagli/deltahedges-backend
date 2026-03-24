import type { Job } from "bullmq";
import { executeForcedClose } from "../services/slot-runtime-service.js";

export async function processForcedClose(job: Job<{ slotId: string; plannedFor: string }>) {
  return executeForcedClose(job.data.slotId);
}
