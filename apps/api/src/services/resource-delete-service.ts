import { pool } from "../db/pool.js";
import { getMetaApiOpenPositions } from "./metaapi-service.js";

type SavedAccountRow = {
  id: string;
  label: string;
};

type SlotRow = {
  id: string;
  slot_name: string;
};

type SlotAccountRow = {
  account_type: "PROP" | "BROKER";
  metaapi_account_id: string | null;
};

export async function deleteSavedAccountForUser(userId: string, accountId: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const savedAccountResult = await client.query<SavedAccountRow>(
      `
        select id, label
        from saved_accounts
        where id = $1 and user_id = $2 and deleted_at is null
        limit 1
      `,
      [accountId, userId],
    );

    if (!savedAccountResult.rowCount) {
      throw new Error("Saved account not found");
    }

    const savedAccount = savedAccountResult.rows[0]!;

    await client.query(
      `
        update saved_accounts
        set
          label = concat(label, ' [deleted ', substr(id::text, 1, 8), ']'),
          deleted_at = now(),
          updated_at = now()
        where id = $1 and user_id = $2
      `,
      [accountId, userId],
    );

    await client.query("commit");

    return {
      accountId: savedAccount.id,
      label: savedAccount.label,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteSlotForUser(userId: string, slotId: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const slotResult = await client.query<SlotRow>(
      `
        select id, slot_name
        from hedging_slots
        where id = $1 and user_id = $2
        limit 1
      `,
      [slotId, userId],
    );

    if (!slotResult.rowCount) {
      throw new Error("Slot not found");
    }

    const openTradePairResult = await client.query<{ id: string; symbol: string | null }>(
      `
        select id, symbol
        from trade_pairs
        where slot_id = $1
          and user_id = $2
          and status = 'OPEN'
        limit 1
      `,
      [slotId, userId],
    );

    if (openTradePairResult.rowCount) {
      const slotAccountsResult = await client.query<SlotAccountRow>(
        `
          select account_type, metaapi_account_id
          from trading_accounts
          where slot_id = $1
            and user_id = $2
        `,
        [slotId, userId],
      );

      const symbol = openTradePairResult.rows[0]?.symbol ?? null;
      const livePositions = await Promise.all(
        slotAccountsResult.rows
          .map((row) => row.metaapi_account_id)
          .filter(Boolean)
          .map((accountId) => getMetaApiOpenPositions(accountId!, { symbol })),
      );

      const hasRealOpenPositions = livePositions.some((positions) => positions.length > 0);

      if (hasRealOpenPositions) {
        throw new Error(
          "Questo slot ha ancora una coppia di trade aperta. Chiudila prima di cancellare la card.",
        );
      }
    }

    const slot = slotResult.rows[0]!;

    await client.query(
      `
        delete from hedging_slots
        where id = $1 and user_id = $2
      `,
      [slotId, userId],
    );

    await client.query("commit");

    return {
      slotId: slot.id,
      slotName: slot.slot_name,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
