import test from "node:test";
import assert from "node:assert/strict";
import { generateDailyTradePlan, pickPropLot, pickRandomDirection } from "./index.js";

test("daily plan respects Europe/Rome time windows", () => {
  const plan = generateDailyTradePlan({
    userId: "user_1",
    slotId: "slot_1",
    dateKey: "2026-03-24",
    maxDailyTrades: 2,
  });

  assert.equal(plan.entryTimes.length, 2);
  assert.notEqual(plan.entryTimes[0], plan.entryTimes[1]);
  assert.match(plan.entryTimes[0], /T(0[2-9]|1[0-7]):/);
  assert.match(plan.forcedCloseTime, /T22:(0[0-9]|1[0-9]|2[0-9]|30):/);
});

test("direction picker is deterministic per seed", () => {
  assert.equal(pickRandomDirection("seed"), pickRandomDirection("seed"));
});

test("prop lot stays inside 0.80 and 2.00 with 0.01 precision", () => {
  const value = pickPropLot("seed");
  assert.ok(value >= 0.8 && value <= 2);
  assert.equal(Number((value * 100).toFixed(0)), value * 100);
});
