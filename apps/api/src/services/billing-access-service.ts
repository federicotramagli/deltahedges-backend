import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { closeMetaApiPositions, destroyMetaApiAccount } from "./metaapi-service.js";

type BillingSlotAccountRow = {
  slot_id: string;
  metaapi_account_id: string | null;
};

type BillingSavedAccountRow = {
  metaapi_account_id: string | null;
};

export async function revokeUserBillingAccess(userId: string) {
  const metaApiAccountIdsResult = await pool.query<BillingSlotAccountRow>(
    `
      select distinct ta.slot_id, ta.metaapi_account_id
      from trading_accounts ta
      join hedging_slots hs on hs.id = ta.slot_id
      where hs.user_id = $1
        and ta.metaapi_account_id is not null
    `,
    [userId],
  );

  const savedAccountMetaApiIdsResult = await pool.query<BillingSavedAccountRow>(
    `
      select distinct metaapi_account_id
      from saved_accounts
      where user_id = $1
        and metaapi_account_id is not null
        and deleted_at is null
    `,
    [userId],
  );

  const metaApiAccountIds = Array.from(
    new Set(
      [
        ...metaApiAccountIdsResult.rows.map((row) => row.metaapi_account_id),
        ...savedAccountMetaApiIdsResult.rows.map((row) => row.metaapi_account_id),
      ]
        .filter((value): value is string => Boolean(value)),
    ),
  );

  for (const accountId of metaApiAccountIds) {
    try {
      await closeMetaApiPositions(accountId).catch(() => null);
      await destroyMetaApiAccount(accountId);
    } catch (error) {
      logger.warn(
        { error, userId, metaApiAccountId: accountId },
        "Unable to fully destroy MetaApi account during billing revoke",
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query("begin");

    await client.query(
      `
        update proxy_pool
        set status = 'AVAILABLE',
            assigned_user_id = null,
            assigned_at = null,
            updated_at = now()
        where assigned_user_id = $1
      `,
      [userId],
    );

    await client.query(
      `
        update user_profiles
        set proxy_id = null,
            updated_at = now()
        where user_id = $1
      `,
      [userId],
    );

    await client.query(
      `
        update saved_accounts
        set metaapi_account_id = null,
            connection_state = 'error',
            validation_message = 'Abbonamento non attivo. Rinnova il piano per riattivare questo conto.',
            connection_status = null,
            balance = null,
            equity = null,
            last_validated_at = now(),
            updated_at = now()
        where user_id = $1
          and deleted_at is null
      `,
      [userId],
    );

    await client.query(
      `
        delete from hedging_slots
        where user_id = $1
      `,
      [userId],
    );

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
