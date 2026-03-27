import {
  getChallengeAccountSize,
  getEffectiveCycleTarget,
  getEffectiveMultiplier,
  type ChallengeName,
  type CycleState,
  type SlotPhase,
} from "@deltahedge/shared";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import {
  closeMetaApiPositions,
  getMetaApiAccountLiveMetrics,
} from "./metaapi-service.js";
import { publishRuntimeEvent } from "./runtime-events.js";
import { getSlotById } from "./slot-service.js";

type WatchedSlotRow = {
  slot_id: string;
  user_id: string;
  slot_name: string;
  challenge: ChallengeName;
  phase: SlotPhase;
  runtime_status: "DRAFT" | "READY" | "RUNNING" | "PAUSED_MANUAL" | "PAUSED_BILLING" | "FUNDED_BREAK_EVEN_READY";
  cycle_state: CycleState;
  risk_per_trade: string | null;
  phase1_base_target: string | null;
  broker_start_equity: string | null;
  current_target: string | null;
  current_multiplier: string | null;
  current_trade_pair_id: string | null;
  forced_close_at: string | null;
  prop_metaapi_account_id: string | null;
  broker_metaapi_account_id: string | null;
  trade_pair_id: string | null;
  symbol: string | null;
};

type ExitDecision =
  | {
      type: "PHASE_PASS";
      message: string;
      riskEventType: "PHASE_PASSED";
    }
  | {
      type: "HARD_FAIL";
      message: string;
      riskEventType: "HARD_FAIL";
    }
  | {
      type: "RISK_STOP";
      message: string;
      riskEventType: "FORCED_CLOSE";
    }
  | {
      type: "FORCED_CLOSE";
      message: string;
      riskEventType: "FORCED_CLOSE";
    };

let watcherTimer: NodeJS.Timeout | null = null;
let watcherRunning = false;

async function listWatchedSlots() {
  const result = await pool.query<WatchedSlotRow>(
    `
      select
        hs.id as slot_id,
        hs.user_id,
        hs.slot_name,
        hs.challenge,
        hs.phase,
        hs.runtime_status,
        hs.cycle_state,
        sp.risk_per_trade::text,
        sp.phase1_base_target::text,
        sp.broker_start_equity::text,
        sr.current_target::text,
        sr.current_multiplier::text,
        sr.current_trade_pair_id,
        sr.forced_close_at::text,
        prop.metaapi_account_id as prop_metaapi_account_id,
        broker.metaapi_account_id as broker_metaapi_account_id,
        tp.id as trade_pair_id,
        tp.symbol
      from hedging_slots hs
      join slot_parameters sp on sp.slot_id = hs.id
      join slot_runtime sr on sr.slot_id = hs.id
      left join trading_accounts prop
        on prop.slot_id = hs.id and prop.account_type = 'PROP'
      left join trading_accounts broker
        on broker.slot_id = hs.id and broker.account_type = 'BROKER'
      left join trade_pairs tp
        on tp.id = sr.current_trade_pair_id and tp.status = 'OPEN'
      where prop.metaapi_account_id is not null
        and broker.metaapi_account_id is not null
        and (
          hs.runtime_status = 'RUNNING'
          or sr.current_trade_pair_id is not null
        )
    `,
  );

  return result.rows;
}

function buildExitDecision(params: {
  challenge: ChallengeName;
  phase: SlotPhase;
  riskPerTrade: number;
  propEquity: number | null;
  propUnrealizedPnl: number | null;
  forcedCloseAt: string | null;
}) {
  const startingBalance = getChallengeAccountSize(params.challenge);
  const hardFailEquity = startingBalance * 0.9;
  const phasePassEquity =
    params.phase === "Fase 1"
      ? startingBalance * 1.08
      : params.phase === "Fase 2"
        ? startingBalance * 1.05
        : null;
  const riskStopLoss = startingBalance * (params.riskPerTrade / 100);

  if (params.propEquity !== null && params.propEquity <= hardFailEquity) {
    return {
      type: "HARD_FAIL" as const,
      message: `Prop equity reached hard fail threshold (${params.propEquity.toFixed(2)} <= ${hardFailEquity.toFixed(2)})`,
      riskEventType: "HARD_FAIL" as const,
    };
  }

  if (
    phasePassEquity !== null &&
    params.propEquity !== null &&
    params.propEquity >= phasePassEquity
  ) {
    return {
      type: "PHASE_PASS" as const,
      message: `Prop equity reached phase target (${params.propEquity.toFixed(2)} >= ${phasePassEquity.toFixed(2)})`,
      riskEventType: "PHASE_PASSED" as const,
    };
  }

  if (
    params.propUnrealizedPnl !== null &&
    params.propUnrealizedPnl <= -riskStopLoss
  ) {
    return {
      type: "RISK_STOP" as const,
      message: `Prop unrealized PnL reached risk stop (${params.propUnrealizedPnl.toFixed(2)} <= -${riskStopLoss.toFixed(2)})`,
      riskEventType: "FORCED_CLOSE" as const,
    };
  }

  if (params.forcedCloseAt) {
    const forcedCloseAtMs = Date.parse(params.forcedCloseAt);
    if (!Number.isNaN(forcedCloseAtMs) && Date.now() >= forcedCloseAtMs) {
      return {
        type: "FORCED_CLOSE" as const,
        message: `Forced close reached at ${params.forcedCloseAt}`,
        riskEventType: "FORCED_CLOSE" as const,
      };
    }
  }

  return null;
}

async function persistRuntimeMetrics(params: {
  slotId: string;
  tradePairId: string | null;
  propEquity: number | null;
  brokerEquity: number | null;
  propUnrealizedPnl: number | null;
  brokerUnrealizedPnl: number | null;
}) {
  await pool.query(
    `
      update slot_runtime
      set prop_equity = coalesce($2, prop_equity),
          broker_equity = coalesce($3, broker_equity),
          updated_at = now()
      where slot_id = $1
    `,
    [params.slotId, params.propEquity, params.brokerEquity],
  );

  if (params.tradePairId) {
    await pool.query(
      `
        update trade_pairs
        set prop_unrealized_pnl = coalesce($2, prop_unrealized_pnl),
            broker_unrealized_pnl = coalesce($3, broker_unrealized_pnl),
            updated_at = now()
        where id = $1 and status = 'OPEN'
      `,
      [params.tradePairId, params.propUnrealizedPnl ?? 0, params.brokerUnrealizedPnl ?? 0],
    );
  }
}

function getFailureCycleState(phase: SlotPhase): CycleState {
  if (phase === "Fase 1") return "FASE_1_FAILED";
  if (phase === "Fase 2") return "FASE_2_FAILED";
  return "FUNDED_FAILED";
}

function getFailureCycleOutcome(phase: SlotPhase) {
  if (phase === "Fase 1") return "FAIL_FASE_1";
  if (phase === "Fase 2") return "FAIL_FASE_2";
  return "FAIL_FUNDED";
}

async function finalizeTriggeredExit(
  row: WatchedSlotRow,
  decision: ExitDecision,
  propMetrics: Awaited<ReturnType<typeof getMetaApiAccountLiveMetrics>>,
  brokerMetrics: Awaited<ReturnType<typeof getMetaApiAccountLiveMetrics>>,
) {
  const propEquity = propMetrics.equity;
  const brokerEquity = brokerMetrics.equity;
  const propUnrealizedPnl = propMetrics.unrealizedPnl ?? 0;
  const brokerUnrealizedPnl = brokerMetrics.unrealizedPnl ?? 0;
  const phase1BaseTarget = Number(row.phase1_base_target ?? 0);

  await closeMetaApiPositions(row.prop_metaapi_account_id!, {
    symbol: row.symbol ?? "XAUUSD",
  });
  await closeMetaApiPositions(row.broker_metaapi_account_id!, {
    symbol: row.symbol ?? "XAUUSD",
  });

  const client = await pool.connect();
  try {
    await client.query("begin");

    await client.query(
      `
        update trade_pairs
        set status = 'CLOSED',
            close_time = now(),
            prop_realized_pnl = $2,
            broker_realized_pnl = $3,
            prop_unrealized_pnl = 0,
            broker_unrealized_pnl = 0,
            updated_at = now()
        where id = $1 and status = 'OPEN'
      `,
      [row.trade_pair_id, propUnrealizedPnl, brokerUnrealizedPnl],
    );

    if (decision.type === "RISK_STOP" || decision.type === "FORCED_CLOSE") {
      await client.query(
        `
          update slot_runtime
          set current_trade_pair_id = null,
              prop_equity = coalesce($2, prop_equity),
              broker_equity = coalesce($3, broker_equity),
              updated_at = now()
          where slot_id = $1
        `,
        [row.slot_id, propEquity, brokerEquity],
      );
    } else if (decision.type === "HARD_FAIL") {
      await client.query(
        `
          update hedging_slots
          set runtime_status = 'PAUSED_MANUAL',
              cycle_state = $3,
              updated_at = now()
          where id = $1 and user_id = $2
        `,
        [row.slot_id, row.user_id, getFailureCycleState(row.phase)],
      );

      await client.query(
        `
          update slot_runtime
          set current_trade_pair_id = null,
              prop_equity = coalesce($2, prop_equity),
              broker_equity = coalesce($3, broker_equity),
              updated_at = now()
          where slot_id = $1
        `,
        [row.slot_id, propEquity, brokerEquity],
      );

      await client.query(
        `
          insert into cycle_logs (
            user_id, slot_id, outcome, broker_realized_profit, prop_cost, net_profit
          )
          values ($1, $2, $3, $4, $5, $6)
        `,
        [
          row.user_id,
          row.slot_id,
          getFailureCycleOutcome(row.phase),
          brokerUnrealizedPnl,
          Math.max(-propUnrealizedPnl, 0),
          brokerUnrealizedPnl - Math.max(-propUnrealizedPnl, 0),
        ],
      );
    } else if (row.phase === "Fase 1") {
      const nextPhase: SlotPhase = "Fase 2";
      await client.query(
        `
          update hedging_slots
          set phase = 'Fase 2',
              runtime_status = 'READY',
              cycle_state = 'FASE_1_PASSED',
              updated_at = now()
          where id = $1 and user_id = $2
        `,
        [row.slot_id, row.user_id],
      );
      await client.query(
        `
          update slot_runtime
          set current_trade_pair_id = null,
              current_target = $2,
              current_multiplier = $3,
              prop_equity = coalesce($4, prop_equity),
              broker_equity = coalesce($5, broker_equity),
              updated_at = now()
          where slot_id = $1
        `,
        [
          row.slot_id,
          getEffectiveCycleTarget({
            challenge: row.challenge,
            phase: nextPhase,
            phase1BaseTarget,
          }),
          getEffectiveMultiplier({
            challenge: row.challenge,
            phase: nextPhase,
            phase1BaseTarget,
          }),
          propEquity,
          brokerEquity,
        ],
      );
    } else {
      const nextPhase: SlotPhase = "Funded";
      await client.query(
        `
          update hedging_slots
          set phase = 'Funded',
              runtime_status = 'READY',
              cycle_state = 'FASE_2_PASSED',
              updated_at = now()
          where id = $1 and user_id = $2
        `,
        [row.slot_id, row.user_id],
      );
      await client.query(
        `
          update slot_runtime
          set current_trade_pair_id = null,
              current_target = $2,
              current_multiplier = $3,
              prop_equity = coalesce($4, prop_equity),
              broker_equity = coalesce($5, broker_equity),
              updated_at = now()
          where slot_id = $1
        `,
        [
          row.slot_id,
          getEffectiveCycleTarget({
            challenge: row.challenge,
            phase: nextPhase,
            phase1BaseTarget,
          }),
          getEffectiveMultiplier({
            challenge: row.challenge,
            phase: nextPhase,
            phase1BaseTarget,
          }),
          propEquity,
          brokerEquity,
        ],
      );
    }

    await client.query(
      `
        insert into risk_events (user_id, slot_id, severity, event_type, message, metadata)
        values ($1, $2, $3, $4, $5, $6::jsonb)
      `,
      [
        row.user_id,
        row.slot_id,
        decision.type === "HARD_FAIL" ? "high" : "info",
        decision.riskEventType,
        decision.message,
        JSON.stringify({
          propEquity,
          brokerEquity,
          propUnrealizedPnl,
          brokerUnrealizedPnl,
          phase: row.phase,
          challenge: row.challenge,
        }),
      ],
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  await publishRuntimeEvent({
    event: "trade_pair.closed",
    userId: row.user_id,
    slotId: row.slot_id,
    payload: {
      id: row.trade_pair_id,
      brokerRealizedPnl: brokerUnrealizedPnl,
      propRealizedPnl: propUnrealizedPnl,
      reason: decision.type,
    },
    emittedAt: new Date().toISOString(),
  });

  await publishRuntimeEvent({
    event: "risk.event",
    userId: row.user_id,
    slotId: row.slot_id,
    payload: {
      type: decision.type,
      message: decision.message,
      propEquity,
      brokerEquity,
      propUnrealizedPnl,
      brokerUnrealizedPnl,
    },
    emittedAt: new Date().toISOString(),
  });

  const snapshot = await getSlotById(row.user_id, row.slot_id);
  await publishRuntimeEvent({
    event: "slot.updated",
    userId: row.user_id,
    slotId: row.slot_id,
    payload: snapshot,
    emittedAt: new Date().toISOString(),
  });
}

async function monitorSlot(row: WatchedSlotRow) {
  const [propMetrics, brokerMetrics] = await Promise.all([
    getMetaApiAccountLiveMetrics(row.prop_metaapi_account_id!),
    getMetaApiAccountLiveMetrics(row.broker_metaapi_account_id!),
  ]);

  await persistRuntimeMetrics({
    slotId: row.slot_id,
    tradePairId: row.trade_pair_id,
    propEquity: propMetrics.equity,
    brokerEquity: brokerMetrics.equity,
    propUnrealizedPnl: propMetrics.unrealizedPnl,
    brokerUnrealizedPnl: brokerMetrics.unrealizedPnl,
  });

  if (!row.trade_pair_id) {
    return;
  }

  const decision = buildExitDecision({
    challenge: row.challenge,
    phase: row.phase,
      riskPerTrade: Number(row.risk_per_trade ?? 1.5),
      propEquity: propMetrics.equity,
      propUnrealizedPnl: propMetrics.unrealizedPnl,
      forcedCloseAt: row.forced_close_at,
    });

  if (!decision) {
    return;
  }

  await finalizeTriggeredExit(row, decision, propMetrics, brokerMetrics);
}

async function tickEquityWatcher() {
  if (watcherRunning) {
    return;
  }

  watcherRunning = true;
  try {
    const slots = await listWatchedSlots();
    for (const row of slots) {
      try {
        await monitorSlot(row);
      } catch (error) {
        logger.error(
          {
            slotId: row.slot_id,
            userId: row.user_id,
            error,
          },
          "Equity watcher failed for slot",
        );
      }
    }
  } finally {
    watcherRunning = false;
  }
}

export function startEquityWatcher(intervalMs: number) {
  if (watcherTimer) {
    return;
  }

  void tickEquityWatcher();
  watcherTimer = setInterval(() => {
    void tickEquityWatcher();
  }, Math.max(intervalMs, 3000));
}

export function stopEquityWatcher() {
  if (!watcherTimer) {
    return;
  }

  clearInterval(watcherTimer);
  watcherTimer = null;
}
