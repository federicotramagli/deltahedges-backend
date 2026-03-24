import { Job } from "bullmq";
import { queues } from "../services/queues.js";
import { createDailyPlansForRunningSlots } from "../services/slot-runtime-service.js";

export async function processDailyPlanner(_job: Job<{ dateKey: string }>) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const plans = await createDailyPlansForRunningSlots(dateKey);

  for (const plan of plans) {
    for (const entryTime of plan.entryTimes) {
      const delay = Math.max(new Date(entryTime).getTime() - Date.now(), 0);
      await queues.slotEntry.add(
        "slot-entry",
        { slotId: plan.slotId, plannedFor: entryTime },
        { delay },
      );
    }

    const forcedDelay = Math.max(new Date(plan.forcedCloseTime).getTime() - Date.now(), 0);
    await queues.slotForcedClose.add(
      "slot-forced-close",
      { slotId: plan.slotId, plannedFor: plan.forcedCloseTime },
      { delay: forcedDelay },
    );
  }
}
