import { pool } from "../db/pool.js";
import { decryptSecret } from "./crypto-service.js";
import {
  provisionMetaApiAccount,
  waitUntilMetaApiAccountReady,
  type ProvisionMetaApiAccountResult,
} from "./metaapi-service.js";

type ReconcileSourceRow = {
  source_kind: "saved_account" | "slot_account";
  source_id: string;
  account_type: "PROP" | "BROKER";
  platform: "mt4" | "mt5";
  login_ciphertext: string;
  password_ciphertext: string;
  server_ciphertext: string;
  metaapi_account_id: string | null;
};

export interface MetaApiNetworkReconcileItemResult {
  sourceKind: "saved_account" | "slot_account";
  sourceId: string;
  accountType: "PROP" | "BROKER";
  platform: "mt4" | "mt5";
  loginMasked: string;
  server: string;
  previousMetaApiAccountId: string | null;
  nextMetaApiAccountId: string | null;
  deploymentState: ProvisionMetaApiAccountResult["deploymentState"] | null;
  connectionStatus: string | null;
  waitedUntilReady: boolean;
  error: string | null;
}

function maskLogin(login: string) {
  if (!login) return "";
  if (login.length <= 4) return login;
  return `${login.slice(0, 2)}•••${login.slice(-2)}`;
}

async function loadReconcileTargets(userId: string) {
  const result = await pool.query<ReconcileSourceRow>(
    `
      select
        'saved_account'::text as source_kind,
        sa.id::text as source_id,
        sa.account_type,
        sa.platform,
        sa.login_ciphertext,
        sa.password_ciphertext,
        sa.server_ciphertext,
        sa.metaapi_account_id
      from saved_accounts sa
      where sa.user_id = $1
        and sa.deleted_at is null
        and sa.login_ciphertext is not null
        and sa.password_ciphertext is not null
        and sa.server_ciphertext is not null

      union all

      select
        'slot_account'::text as source_kind,
        ta.id::text as source_id,
        ta.account_type,
        ta.platform,
        ta.login_ciphertext,
        ta.password_ciphertext,
        ta.server_ciphertext,
        ta.metaapi_account_id
      from trading_accounts ta
      where ta.user_id = $1
        and ta.login_ciphertext is not null
        and ta.password_ciphertext is not null
        and ta.server_ciphertext is not null
    `,
    [userId],
  );

  const deduped = new Map<string, ReconcileSourceRow>();
  for (const row of result.rows) {
    const login = decryptSecret(row.login_ciphertext);
    const server = decryptSecret(row.server_ciphertext);
    const key = `${row.account_type}:${row.platform}:${login.toLowerCase()}:${server.toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, row);
    }
  }

  return Array.from(deduped.values());
}

async function syncMetaApiAccountReferences(params: {
  userId: string;
  source: ReconcileSourceRow;
  nextMetaApiAccountId: string;
  connectionStatus: string | null;
}) {
  const loginCiphertext = params.source.login_ciphertext;
  const serverCiphertext = params.source.server_ciphertext;
  const platform = params.source.platform;
  const accountType = params.source.account_type;

  await pool.query(
    `
      update saved_accounts
      set metaapi_account_id = $6,
          connection_state = case when $7 = 'CONNECTED' then 'connected' else 'pending' end,
          connection_status = $7,
          last_validated_at = now(),
          updated_at = now()
      where user_id = $1
        and account_type = $2
        and platform = $3
        and login_ciphertext = $4
        and server_ciphertext = $5
        and deleted_at is null
    `,
    [
      params.userId,
      accountType,
      platform,
      loginCiphertext,
      serverCiphertext,
      params.nextMetaApiAccountId,
      params.connectionStatus,
    ],
  );

  await pool.query(
    `
      update trading_accounts
      set metaapi_account_id = $6,
          deployment_state = 'DEPLOYED',
          connection_status = coalesce($7, connection_status),
          updated_at = now()
      where user_id = $1
        and account_type = $2
        and platform = $3
        and login_ciphertext = $4
        and server_ciphertext = $5
    `,
    [
      params.userId,
      accountType,
      platform,
      loginCiphertext,
      serverCiphertext,
      params.nextMetaApiAccountId,
      params.connectionStatus,
    ],
  );
}

export async function reconcileMetaApiDedicatedIpForUser(
  userId: string,
  options: { waitUntilReady?: boolean } = {},
): Promise<MetaApiNetworkReconcileItemResult[]> {
  const targets = await loadReconcileTargets(userId);
  const results: MetaApiNetworkReconcileItemResult[] = [];

  for (const row of targets) {
    const login = decryptSecret(row.login_ciphertext);
    const password = decryptSecret(row.password_ciphertext);
    const server = decryptSecret(row.server_ciphertext);

    try {
      const provisioned = await provisionMetaApiAccount({
        userId,
        slotId: `${row.source_kind}_${row.source_id}`,
        accountType: row.account_type,
        platform: row.platform,
        login,
        password,
        server,
        existingAccountId: row.metaapi_account_id,
      });

      let finalConnectionStatus = provisioned.connectionStatus;
      let waitedUntilReady = false;

      if (options.waitUntilReady) {
        const ready = await waitUntilMetaApiAccountReady(provisioned.accountId, {
          retries: 90,
          delayMs: 2000,
        });
        finalConnectionStatus = ready.connectionStatus ?? finalConnectionStatus;
        waitedUntilReady = true;
      }

      await syncMetaApiAccountReferences({
        userId,
        source: row,
        nextMetaApiAccountId: provisioned.accountId,
        connectionStatus: finalConnectionStatus,
      });

      results.push({
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        accountType: row.account_type,
        platform: row.platform,
        loginMasked: maskLogin(login),
        server,
        previousMetaApiAccountId: row.metaapi_account_id,
        nextMetaApiAccountId: provisioned.accountId,
        deploymentState: provisioned.deploymentState,
        connectionStatus: finalConnectionStatus,
        waitedUntilReady,
        error: null,
      });
    } catch (error) {
      results.push({
        sourceKind: row.source_kind,
        sourceId: row.source_id,
        accountType: row.account_type,
        platform: row.platform,
        loginMasked: maskLogin(login),
        server,
        previousMetaApiAccountId: row.metaapi_account_id,
        nextMetaApiAccountId: null,
        deploymentState: null,
        connectionStatus: null,
        waitedUntilReady: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}
