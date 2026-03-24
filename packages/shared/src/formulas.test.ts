import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCycleProjection,
  calculatePhase1PassLoss,
  calculatePhase2PassLoss,
  calculatePhase2RecoveryTarget,
  FUNDED_BROKER_RATIO,
  getEffectiveMultiplier,
  getFundedGrossPayoutTarget,
} from "./index.js";

test("phase 1 pass loss uses 80 percent of base target", () => {
  assert.equal(calculatePhase1PassLoss(1_529), 1_223.2);
});

test("phase 2 recovery target uses phase1 loss plus fee plus 20 percent", () => {
  const phase1Loss = calculatePhase1PassLoss(1_529);
  assert.equal(calculatePhase2RecoveryTarget(phase1Loss, 549), 2_126.64);
});

test("phase 2 pass loss uses 50 percent of phase 2 recovery target", () => {
  assert.equal(calculatePhase2PassLoss(2_126.64), 1_063.32);
});

test("funded multiplier is fixed to 0.40", () => {
  assert.equal(
    getEffectiveMultiplier({
      challenge: "FundingPips 100K",
      phase: "Funded",
      phase1BaseTarget: 1_529,
    }),
    FUNDED_BROKER_RATIO,
  );
});

test("funded gross payout derives from broker entering funded", () => {
  assert.equal(getFundedGrossPayoutTarget(1_725.48), 4_313.7);
});

test("cycle projection keeps payout broker balance at zero", () => {
  const projection = buildCycleProjection({
    challenge: "FundingPips 100K",
    phase1BaseTarget: 1_529,
    brokerStartingEquity: 4_000,
  });

  assert.equal(projection.brokerAfterPayout, 0);
  assert.equal(projection.phase1PassLoss, 1_223.2);
});
