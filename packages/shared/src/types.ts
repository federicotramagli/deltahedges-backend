export const challengeCatalog = {
  "FundingPips 25K": {
    challenge: "FundingPips 25K",
    fee: 199,
    accountSize: 25_000,
  },
  "FundingPips 50K": {
    challenge: "FundingPips 50K",
    fee: 289,
    accountSize: 50_000,
  },
  "FundingPips 100K": {
    challenge: "FundingPips 100K",
    fee: 549,
    accountSize: 100_000,
  },
} as const;

export type ChallengeName = keyof typeof challengeCatalog;

export type SlotPhase = "Fase 1" | "Fase 2" | "Funded";

export type SlotRuntimeStatus =
  | "DRAFT"
  | "READY"
  | "RUNNING"
  | "PAUSED_MANUAL"
  | "PAUSED_BILLING"
  | "FUNDED_BREAK_EVEN_READY";

export type CycleState =
  | "FASE_1_ACTIVE"
  | "FASE_1_PASSED"
  | "FASE_1_FAILED"
  | "FASE_2_ACTIVE"
  | "FASE_2_PASSED"
  | "FASE_2_FAILED"
  | "FUNDED_ACTIVE"
  | "FUNDED_FAILED"
  | "FUNDED_PAYOUT"
  | "PAUSED_BILLING"
  | "FUNDED_BREAK_EVEN_READY";

export type TradeDirection = "BUY" | "SELL";

export type TradingAccountType = "PROP" | "BROKER";

export type DeploymentState =
  | "NOT_DEPLOYED"
  | "DEPLOYING"
  | "DEPLOYED"
  | "DEPLOY_FAILED";

export type RiskEventType =
  | "ORPHAN_ABORT"
  | "DISCONNECT"
  | "HARD_FAIL"
  | "PHASE_PASSED"
  | "FORCED_CLOSE"
  | "BILLING_PAUSE";

export type CycleOutcome =
  | "FAIL_FASE_1"
  | "FAIL_FASE_2"
  | "FAIL_FUNDED"
  | "FUNDED_PAYOUT";

export type ProxyStatus = "AVAILABLE" | "IN_USE" | "DISABLED";

export type SeatStatus = "ACTIVE" | "PAST_DUE" | "CANCELED";
export type SlotAccountConnectionState =
  | "empty"
  | "connecting"
  | "connected"
  | "disconnected";

export interface StrategyInputs {
  challenge: ChallengeName;
  phase1BaseTarget: number;
  brokerStartingEquity: number;
}

export interface SlotSnapshot {
  id: string;
  slot: string;
  challenge: ChallengeName;
  phase: SlotPhase;
  status: CycleState | "OPEN" | "PRACTITIONER" | "FUNDED";
  challengeState: "BOZZA" | "PRONTA" | "ATTIVA" | "PAUSA_BILLING";
  parametersProfile: string;
  brokerAccount: string;
  propPlatform?: "mt4" | "mt5";
  brokerPlatform?: "mt4" | "mt5";
  propLoginMasked?: string;
  brokerLoginMasked?: string;
  propServerHint?: string;
  brokerServerHint?: string;
  propConnectionState?: SlotAccountConnectionState;
  brokerConnectionState?: SlotAccountConnectionState;
  propConnected: boolean;
  brokerConnected: boolean;
  metaApiStatus: "ready" | "partial" | "empty";
  propEquity: number;
  brokerEquity: number;
  propUnrealizedPnl: number | null;
  brokerUnrealizedPnl: number | null;
  target: number;
  hedgeBaseTarget: number;
  multiplier: number;
  brokerStartEquity: number;
  cycleBalance: number;
  riskPerTrade: number;
  maxDailyTrades: number;
  orphanTimeoutMs: number;
  updatedAt: string;
}

export interface SavedAccountSnapshot {
  id: string;
  label: string;
  accountType: TradingAccountType;
  platform: "mt4" | "mt5";
  accountName: string;
  loginMasked: string;
  server: string;
  lotStep: number;
  createdAt: string;
}

export interface DailyTradePlan {
  dateKey: string;
  entryTimes: string[];
  forcedCloseTime: string;
}

export interface RuntimeEvent<TPayload = unknown> {
  event:
    | "slot.updated"
    | "slot.runtime.updated"
    | "trade_pair.opened"
    | "trade_pair.closed"
    | "risk.event"
    | "billing.paused";
  userId: string;
  slotId?: string;
  payload: TPayload;
  emittedAt: string;
}
