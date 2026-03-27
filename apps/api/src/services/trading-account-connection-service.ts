import type { PoolClient } from "pg";
import {
  getMetaApiAccountConnectionSnapshot,
  getMetaApiAccountLiveMetrics,
} from "./metaapi-service.js";

type RefreshableTradingAccountRow = {
  id: string;
  slot_id: string;
  account_type: "PROP" | "BROKER";
  metaapi_account_id: string;
};

export async function refreshTradingAccountConnectionsForUser(
  client: PoolClient,
  userId: string,
) {
  const result = await client.query<RefreshableTradingAccountRow>(
    `
      select id, slot_id, account_type, metaapi_account_id
      from trading_accounts
      where user_id = $1
        and metaapi_account_id is not null
    `,
    [userId],
  );

  for (const row of result.rows) {
    try {
      const snapshot = await getMetaApiAccountConnectionSnapshot(row.metaapi_account_id);
      const metrics =
        snapshot.connectionStatus === "CONNECTED"
          ? await getMetaApiAccountLiveMetrics(row.metaapi_account_id).catch(() => null)
          : null;

      await client.query(
        `
          update trading_accounts
          set
            deployment_state = $2,
            connection_status = $3,
            updated_at = now()
          where id = $1
        `,
        [
          row.id,
          snapshot.deploymentState === "UNKNOWN"
            ? "NOT_DEPLOYED"
            : snapshot.deploymentState,
          metrics?.connectionStatus ?? snapshot.connectionStatus,
        ],
      );

      if (metrics && metrics.connectionStatus === "CONNECTED") {
        await client.query(
          `
            insert into slot_runtime (slot_id, prop_equity, broker_equity)
            values (
              $1,
              case when $2 = 'PROP' then $3 else null end,
              case when $2 = 'BROKER' then $3 else null end
            )
            on conflict (slot_id)
            do update set
              prop_equity = case when $2 = 'PROP' then $3 else slot_runtime.prop_equity end,
              broker_equity = case when $2 = 'BROKER' then $3 else slot_runtime.broker_equity end
          `,
          [row.slot_id, row.account_type, metrics.equity],
        );
      }
    } catch {
      // Keep the last known snapshot when MetaApi refresh fails.
    }
  }
}
