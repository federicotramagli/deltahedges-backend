import type { Job } from "bullmq";
import { executeScheduledEntry } from "../services/slot-runtime-service.js";

export async function processSlotEntry(job: Job<{ slotId: string; plannedFor: string }>) {
  return executeScheduledEntry(job.data.slotId, job.data.plannedFor);
}
