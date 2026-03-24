import {
  calculateBrokerLot,
  generateDailyTradePlan,
  getEffectiveMultiplier,
  type ChallengeName,
  pickPropLot,
  pickRandomDirection,
} from "@deltahedge/shared";
import type { PoolClient } from "pg";
import { pool } from "./db.js";
import { publishRuntimeEvent } from "./runtime-events.js";

interface RunnableSlot {
  id: string;
  user_id: string;
  slot_name: string;
  challenge: ChallengeName;
  phase: "Fase 1" | "Fase 2" | "Funded";
  broker_account_name: string | null;
  max_daily_trades: number;
  orphan_timeout_ms: number;
  phase1_base_target: number;
  broker_lot_step: number | null;
}

async function getRunningSlots(client: PoolClient) {
  const result = await client.query<RunnableSlot>(
    `
      select
        hs.id,
        hs.user_id,
        hs.slot_name,
        hs.challenge,
        hs.phase,
        hs.broker_account_name,
        sp.max_daily_trades,
        sp.orphan_timeout_ms,
        sp.phase1_base_target,
        broker.broker_lot_step
      from hedging_slots hs
      join slot_parameters sp on sp.slot_id = hs.id
      left join trading_accounts broker
        on broker.slot_id = hs.id and broker.account_type = 'BROKER'
      where hs.runtime_status = 'RUNNING'
    `,
  );

  return result.rows;
}

export async function createDailyPlansForRunningSlots(dateKey: string) {
  const client = await pool.connect();
  try {
    const slots = await getRunningSlots(client);
    const plans: Array<{ slotId: string; userId: string; entryTimes: string[]; forcedCloseTime: string }> = [];

    for (const slot of slots) {
      const plan = generateDailyTradePlan({
        userId: slot.user_id,
        slotId: slot.id,
        dateKey,
        maxDailyTrades: slot.max_daily_trades,
      });

      await client.query(
        `
          update slot_runtime
          set entry_schedule_json = $2::jsonb,
              forced_close_at = $3::timestamptz,
              trade_count_today = 0,
              updated_at = now()
          where slot_id = $1
        `,
        [slot.id, JSON.stringify(plan.entryTimes), plan.forcedCloseTime],
      );

      plans.push({
        slotId: slot.id,
        userId: slot.user_id,
        entryTimes: plan.entryTimes,
        forcedCloseTime: plan.forcedCloseTime,
      });
    }

    return plans;
  } finally {
    client.release();
  }
}

export async function executeScheduledEntry(slotId: string, plannedFor: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const slotResult = await client.query<RunnableSlot & { current_multiplier: number; current_target: number }>(
      `
        select
          hs.id,
          hs.user_id,
          hs.slot_name,
          hs.challenge,
          hs.phase,
          hs.broker_account_name,
          sp.max_daily_trades,
          sp.orphan_timeout_ms,
          sp.phase1_base_target,
          broker.broker_lot_step,
          sr.current_multiplier,
          sr.current_target
        from hedging_slots hs
        join slot_parameters sp on sp.slot_id = hs.id
        join slot_runtime sr on sr.slot_id = hs.id
        left join trading_accounts broker
          on broker.slot_id = hs.id and broker.account_type = 'BROKER'
        where hs.id = $1
          and hs.runtime_status = 'RUNNING'
      `,
      [slotId],
    );

    if (!slotResult.rowCount) {
      await client.query("rollback");
      return null;
    }

    const slot = slotResult.rows[0]!;
    const openTrade = await client.query(
      `
        select id
        from trade_pairs
        where slot_id = $1
          and status in ('PENDING', 'OPEN')
        limit 1
      `,
      [slot.id],
    );

    if (openTrade.rowCount) {
      await client.query("rollback");
      return null;
    }

    const direction = pickRandomDirection(`${slot.user_id}:${slot.id}:${plannedFor}`);
    const propLot = pickPropLot(`${slot.user_id}:${slot.id}:${plannedFor}`);
    const multiplier =
      Number(slot.current_multiplier) ||
      getEffectiveMultiplier({
        challenge: slot.challenge,
        phase: slot.phase,
        phase1BaseTarget: Number(slot.phase1_base_target),
      });
    const brokerLot = calculateBrokerLot({
      propLot,
      brokerMultiplier: multiplier,
      brokerLotStep: Number(slot.broker_lot_step ?? 0.01),
    });

    const tradeResult = await client.query<{
      id: string;
      prop_lot_size: string;
      broker_lot_final: string;
      direction: "BUY" | "SELL";
    }>(
      `
        insert into trade_pairs (
          user_id, slot_id, phase, symbol, direction, status,
          prop_ticket_id, broker_ticket_id,
          prop_lot_size, broker_lot_raw, broker_lot_final,
          open_time
        )
        values ($1, $2, $3, 'XAUUSD', $4, 'OPEN', $5, $6, $7, $8, $9, now())
        returning id, prop_lot_size, broker_lot_final, direction
      `,
      [
        slot.user_id,
        slot.id,
        slot.phase,
        direction,
        `prop_${Date.now()}`,
        `broker_${Date.now()}`,
        propLot,
        brokerLot.raw,
        brokerLot.rounded,
      ],
    );

    const trade = tradeResult.rows[0]!;
    await client.query(
      `
        update slot_runtime
        set current_trade_pair_id = $2,
            last_entry_time = now(),
            trade_count_today = trade_count_today + 1,
            updated_at = now()
        where slot_id = $1
      `,
      [slot.id, trade.id],
    );

    await client.query("commit");

    await publishRuntimeEvent({
      event: "trade_pair.opened",
      userId: slot.user_id,
      slotId: slot.id,
      payload: {
        id: trade.id,
        phase: slot.phase,
        symbol: "XAUUSD",
        direction: trade.direction,
        propLotSize: Number(trade.prop_lot_size),
        brokerLotSize: Number(trade.broker_lot_final),
      },
      emittedAt: new Date().toISOString(),
    });

    return trade;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function executeForcedClose(slotId: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query<{
      id: string;
      user_id: string;
      slot_id: string;
      broker_realized_pnl: string;
      prop_realized_pnl: string;
    }>(
      `
        update trade_pairs tp
        set status = 'CLOSED',
            close_time = now(),
            updated_at = now()
        from hedging_slots hs
        where tp.slot_id = $1
          and hs.id = tp.slot_id
          and tp.status = 'OPEN'
        returning tp.id, hs.user_id, tp.slot_id, tp.broker_realized_pnl, tp.prop_realized_pnl
      `,
      [slotId],
    );

    await client.query(
      `
        update slot_runtime
        set current_trade_pair_id = null,
            updated_at = now()
        where slot_id = $1
      `,
      [slotId],
    );
    await client.query("commit");

    const trade = result.rows[0];
    if (trade) {
      await publishRuntimeEvent({
        event: "trade_pair.closed",
        userId: trade.user_id,
        slotId: trade.slot_id,
        payload: {
          id: trade.id,
          brokerRealizedPnl: Number(trade.broker_realized_pnl),
          propRealizedPnl: Number(trade.prop_realized_pnl),
          reason: "FORCED_CLOSE",
        },
        emittedAt: new Date().toISOString(),
      });
    }

    return trade;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
