import crypto from "node:crypto";

function seededUnit(seed: string, index: number) {
  const hash = crypto
    .createHash("sha256")
    .update(`${seed}:${index}`)
    .digest("hex")
    .slice(0, 12);

  return parseInt(hash, 16) / 0xffffffffffff;
}

function uniqueMinutePool(seed: string, count: number, min: number, max: number) {
  const chosen = new Set<number>();
  let cursor = 0;

  while (chosen.size < count) {
    const value = seededUnit(seed, cursor);
    const minute = min + Math.floor(value * (max - min + 1));
    chosen.add(minute);
    cursor += 1;
  }

  return [...chosen].sort((left, right) => left - right);
}

function toIsoLocal(dateKey: string, totalMinutes: number, timezone = "Europe/Rome") {
  const hours = Math.floor(totalMinutes / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (totalMinutes % 60).toString().padStart(2, "0");

  return `${dateKey}T${hours}:${minutes}:00[${timezone}]`;
}

export function generateDailyTradePlan(params: {
  userId: string;
  slotId: string;
  dateKey: string;
  maxDailyTrades: number;
  timezone?: string;
}) {
  const timezone = params.timezone ?? "Europe/Rome";
  const entryCount = Math.max(0, Math.min(params.maxDailyTrades, 2));
  const entryMinutes = uniqueMinutePool(
    `${params.userId}:${params.slotId}:${params.dateKey}:entry`,
    entryCount,
    2 * 60,
    17 * 60,
  );
  const forcedCloseMinutes = uniqueMinutePool(
    `${params.userId}:${params.slotId}:${params.dateKey}:forced-close`,
    1,
    22 * 60,
    22 * 60 + 30,
  )[0]!;

  return {
    dateKey: params.dateKey,
    entryTimes: entryMinutes.map((minute) =>
      toIsoLocal(params.dateKey, minute, timezone),
    ),
    forcedCloseTime: toIsoLocal(params.dateKey, forcedCloseMinutes, timezone),
  };
}

export function pickRandomDirection(seed: string): "BUY" | "SELL" {
  return seededUnit(seed, 0) >= 0.5 ? "BUY" : "SELL";
}

export function pickPropLot(seed: string, min = 0.8, max = 2, step = 0.01) {
  const raw = min + seededUnit(seed, 1) * (max - min);
  const rounded = Math.round(raw / step) * step;
  return Number(rounded.toFixed(2));
}
