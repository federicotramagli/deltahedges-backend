import { pool } from "../db/pool.js";

type SavedAccountRow = {
  id: string;
  label: string;
};

type SlotRow = {
  id: string;
  slot_name: string;
};

export async function deleteSavedAccountForUser(userId: string, accountId: string) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const savedAccountResult = await client.query<SavedAccountRow>(
      `
        select id, label
        from saved_accounts
        where id = $1 and user_id = $2
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
        delete from saved_accounts
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

    const openTradePairResult = await client.query<{ id: string }>(
      `
        select id
        from trade_pairs
        where slot_id = $1
          and user_id = $2
          and status = 'OPEN'
        limit 1
      `,
      [slotId, userId],
    );

    if (openTradePairResult.rowCount) {
      throw new Error(
        "Questo slot ha ancora una coppia di trade aperta. Chiudila prima di cancellare la card.",
      );
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
