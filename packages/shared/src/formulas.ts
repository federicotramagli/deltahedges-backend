import { challengeCatalog, type ChallengeName, type SlotPhase } from "./types.js";

export const FUNDED_BROKER_RATIO = 0.4;

export function getChallengeFee(challenge: ChallengeName): number {
  return challengeCatalog[challenge].fee;
}

export function getChallengeAccountSize(challenge: ChallengeName): number {
  return challengeCatalog[challenge].accountSize;
}

export function getPropMaxLoss(challenge: ChallengeName): number {
  return getChallengeAccountSize(challenge) * 0.1;
}

export function calculatePhase1PassLoss(phase1BaseTarget: number): number {
  return phase1BaseTarget * 0.8;
}

export function calculatePhase2RecoveryTarget(
  phase1PassLoss: number,
  challengeFee: number,
): number {
  return (phase1PassLoss + challengeFee) * 1.2;
}

export function calculatePhase2PassLoss(phase2RecoveryTarget: number): number {
  return phase2RecoveryTarget * 0.5;
}

export function getFundedRecoveryTarget(challenge: ChallengeName): number {
  return getPropMaxLoss(challenge) * FUNDED_BROKER_RATIO;
}

export function getFundedGrossPayoutTarget(
  brokerBalanceEnteringFunded: number,
): number {
  return brokerBalanceEnteringFunded / FUNDED_BROKER_RATIO;
}

export function getEffectiveCycleTarget(input: {
  challenge: ChallengeName;
  phase: SlotPhase;
  phase1BaseTarget: number;
}): number {
  if (input.phase === "Fase 1") return input.phase1BaseTarget;

  if (input.phase === "Fase 2") {
    const phase1PassLoss = calculatePhase1PassLoss(input.phase1BaseTarget);
    return calculatePhase2RecoveryTarget(
      phase1PassLoss,
      getChallengeFee(input.challenge),
    );
  }

  return getFundedRecoveryTarget(input.challenge);
}

export function getEffectiveMultiplier(input: {
  challenge: ChallengeName;
  phase: SlotPhase;
  phase1BaseTarget: number;
}): number {
  if (input.phase === "Funded") return FUNDED_BROKER_RATIO;

  return (
    getEffectiveCycleTarget(input) /
    Math.max(getPropMaxLoss(input.challenge), 1)
  );
}

export function calculateBrokerLot(params: {
  propLot: number;
  brokerMultiplier: number;
  brokerLotStep?: number;
}): {
  raw: number;
  rounded: number;
} {
  const brokerLotStep = params.brokerLotStep ?? 0.01;
  const raw = params.propLot * params.brokerMultiplier;
  const rounded =
    Math.ceil(raw / Math.max(brokerLotStep, 0.01)) *
    Math.max(brokerLotStep, 0.01);

  return {
    raw,
    rounded: Number(rounded.toFixed(2)),
  };
}

export function buildCycleProjection(params: {
  challenge: ChallengeName;
  phase1BaseTarget: number;
  brokerStartingEquity: number;
}) {
  const phase1PassLoss = calculatePhase1PassLoss(params.phase1BaseTarget);
  const phase2RecoveryTarget = calculatePhase2RecoveryTarget(
    phase1PassLoss,
    getChallengeFee(params.challenge),
  );
  const phase2PassLoss = calculatePhase2PassLoss(phase2RecoveryTarget);
  const brokerAfterPhase1Pass = params.brokerStartingEquity - phase1PassLoss;
  const brokerAfterPhase2Pass = brokerAfterPhase1Pass - phase2PassLoss;
  const fundedFailGain = getFundedRecoveryTarget(params.challenge);
  const brokerAfterFundedFail = brokerAfterPhase2Pass + fundedFailGain;
  const fundedGrossPayout = getFundedGrossPayoutTarget(brokerAfterPhase2Pass);

  return {
    phase1PassLoss,
    phase2RecoveryTarget,
    phase2PassLoss,
    brokerAfterPhase1Pass,
    brokerAfterPhase2Pass,
    fundedFailGain,
    brokerAfterFundedFail,
    fundedGrossPayout,
    brokerAfterPayout: 0,
  };
}
