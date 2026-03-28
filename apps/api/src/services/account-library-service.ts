import type { PoolClient } from "pg";
import type { SavedAccountSnapshot, TradingAccountType } from "@deltahedge/shared";
import { pool } from "../db/pool.js";
import { adminEmails } from "../config.js";
import { logger } from "../logger.js";
import { decryptSecret, encryptSecret } from "./crypto-service.js";
import {
  getMetaApiAccountConnectionSnapshot,
  getMetaApiAccountLiveMetrics,
  provisionMetaApiAccount,
  waitUntilMetaApiAccountReady,
} from "./metaapi-service.js";
import {
  assignDedicatedProxyForUser,
  getAssignedProxyForUser,
} from "./proxy-service.js";
import { assertAvailableSeatForUser } from "./seat-service.js";
import { refreshTradingAccountConnectionsForUser } from "./trading-account-connection-service.js";

type SavedAccountConnectionState = "pending" | "connected" | "error";

type SavedAccountRow = {
  id: string;
  label: string;
  account_type: TradingAccountType;
  platform: "mt4" | "mt5";
  account_name: string | null;
  login_ciphertext: string;
  password_ciphertext: string;
  server_ciphertext: string;
  broker_lot_step: string | null;
  metaapi_account_id: string | null;
  connection_state: SavedAccountConnectionState;
  validation_message: string | null;
  connection_status: string | null;
  balance: string | null;
  equity: string | null;
  last_validated_at: string | null;
  deleted_at: string | null;
  created_at: string;
};

type TradingAccountBackfillRow = {
  account_type: TradingAccountType;
  platform: "mt4" | "mt5";
  account_name: string | null;
  login_ciphertext: string | null;
  password_ciphertext: string | null;
  server_ciphertext: string | null;
  broker_lot_step: string | null;
  challenge: string | null;
  metaapi_account_id: string | null;
  connection_status: string | null;
};

type SavedAccountValidationInput = {
  metaApiAccountId?: string | null;
  connectionState?: SavedAccountConnectionState;
  validationMessage?: string | null;
  connectionStatus?: string | null;
  balance?: number | null;
  equity?: number | null;
  lastValidatedAt?: string | null;
};

export interface SavedAccountInput {
  label: string;
  accountType: TradingAccountType;
  platform: "mt4" | "mt5";
  accountName?: string;
  login: string;
  password: string;
  server: string;
  lotStep?: number;
}

function maskLogin(login: string) {
  if (login.length <= 3) return login;
  return `${login.slice(0, 2)}***${login.slice(-2)}`;
}

function mapSavedAccountRow(row: SavedAccountRow): SavedAccountSnapshot {
  const login = decryptSecret(row.login_ciphertext);
  const server = decryptSecret(row.server_ciphertext);

  return {
    id: row.id,
    label: row.label,
    accountType: row.account_type,
    platform: row.platform,
    accountName:
      row.account_type === "BROKER"
        ? row.account_name ?? "Broker"
        : row.account_name ?? "FundingPips Prop",
    loginMasked: maskLogin(login),
    server,
    lotStep: Number(row.broker_lot_step ?? 0.01),
    connectionState: row.connection_state ?? "pending",
    validationMessage: row.validation_message,
    connectionStatus: row.connection_status,
    balance: row.balance === null ? null : Number(row.balance),
    equity: row.equity === null ? null : Number(row.equity),
    metaApiAccountId: row.metaapi_account_id,
    lastValidatedAt: row.last_validated_at,
    createdAt: row.created_at,
  } as SavedAccountSnapshot;
}

function isMetaApiConnectionFailureStatus(status: string | null | undefined) {
  return (
    status === "ACCOUNT_FAILED" ||
    status === "BROKER_CONNECTION_FAILED" ||
    status === "DISCONNECTED_FROM_BROKER"
  );
}

function shouldRefreshPendingSavedAccount(row: SavedAccountRow) {
  if (row.deleted_at) return false;
  return row.connection_state === "pending";
}

function isSavedAccountPendingTooLong(row: SavedAccountRow, thresholdMs = 90_000) {
  const reference = row.last_validated_at ?? row.created_at;
  const timestamp = Date.parse(reference ?? "");
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp >= thresholdMs;
}

async function findMatchingSavedAccountRow(
  client: PoolClient,
  userId: string,
  input: SavedAccountInput,
) {
  const result = await client.query<SavedAccountRow>(
    `
      select
        id,
        label,
        account_type,
        platform,
        account_name,
        login_ciphertext,
        password_ciphertext,
        server_ciphertext,
        broker_lot_step::text,
        metaapi_account_id,
        connection_state,
        validation_message,
        connection_status,
        balance::text,
        equity::text,
        last_validated_at::text,
        deleted_at::text,
        created_at::text
      from saved_accounts
      where user_id = $1
        and account_type = $2
        and platform = $3
      order by created_at desc
    `,
    [userId, input.accountType, input.platform],
  );

  const normalizedLogin = input.login.trim();
  const normalizedServer = input.server.trim();

  return (
    result.rows.find((row) => {
      try {
        return (
          decryptSecret(row.login_ciphertext) === normalizedLogin &&
          decryptSecret(row.server_ciphertext) === normalizedServer
        );
      } catch {
        return false;
      }
    }) ?? null
  );
}

export async function upsertSavedAccountForUser(
  client: PoolClient,
  userId: string,
  input: SavedAccountInput,
  options?: {
    preserveExistingLabel?: boolean;
    validation?: SavedAccountValidationInput;
  },
) {
  const normalizedAccountName =
    input.accountType === "BROKER"
      ? input.accountName?.trim() || "Broker"
      : input.accountName?.trim() || "FundingPips Prop";
  const matchingRow = await findMatchingSavedAccountRow(client, userId, input);
  const validation = options?.validation;

  if (matchingRow) {
    const label =
      options?.preserveExistingLabel && matchingRow.label.trim()
        ? matchingRow.label
        : input.label.trim();

    const result = await client.query<SavedAccountRow>(
      `
        update saved_accounts
        set
          label = $2,
          account_name = $3,
          login_ciphertext = $4,
          password_ciphertext = $5,
          server_ciphertext = $6,
          broker_lot_step = $7,
          metaapi_account_id = $8,
          connection_state = $9,
          validation_message = $10,
          connection_status = $11,
          balance = $12,
          equity = $13,
          last_validated_at = $14,
          deleted_at = null,
          updated_at = now()
        where id = $1
        returning
          id,
          label,
          account_type,
          platform,
          account_name,
          login_ciphertext,
          password_ciphertext,
          server_ciphertext,
          broker_lot_step::text,
          metaapi_account_id,
          connection_state,
          validation_message,
          connection_status,
          balance::text,
          equity::text,
          last_validated_at::text,
          deleted_at::text,
          created_at::text
      `,
      [
        matchingRow.id,
        label,
        normalizedAccountName,
        encryptSecret(input.login.trim()),
        encryptSecret(input.password.trim()),
        encryptSecret(input.server.trim()),
        input.accountType === "BROKER" ? input.lotStep ?? 0.01 : 0.01,
        validation?.metaApiAccountId !== undefined
          ? validation.metaApiAccountId
          : matchingRow.metaapi_account_id,
        validation?.connectionState ?? matchingRow.connection_state ?? "pending",
        validation?.validationMessage !== undefined
          ? validation.validationMessage
          : matchingRow.validation_message,
        validation?.connectionStatus !== undefined
          ? validation.connectionStatus
          : matchingRow.connection_status,
        validation?.balance !== undefined
          ? validation.balance
          : matchingRow.balance === null
            ? null
            : Number(matchingRow.balance),
        validation?.equity !== undefined
          ? validation.equity
          : matchingRow.equity === null
            ? null
            : Number(matchingRow.equity),
        validation?.lastValidatedAt !== undefined
          ? validation.lastValidatedAt
          : matchingRow.last_validated_at,
      ],
    );

    return mapSavedAccountRow(result.rows[0]!);
  }

  const result = await client.query<SavedAccountRow>(
    `
      insert into saved_accounts (
        user_id,
        label,
        account_type,
        platform,
        account_name,
        login_ciphertext,
        password_ciphertext,
        server_ciphertext,
        broker_lot_step,
        metaapi_account_id,
        connection_state,
        validation_message,
        connection_status,
        balance,
        equity,
        last_validated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      returning
        id,
        label,
        account_type,
        platform,
        account_name,
        login_ciphertext,
        password_ciphertext,
        server_ciphertext,
        broker_lot_step::text,
        metaapi_account_id,
        connection_state,
        validation_message,
        connection_status,
        balance::text,
        equity::text,
        last_validated_at::text,
        deleted_at::text,
        created_at::text
    `,
    [
      userId,
      input.label.trim(),
      input.accountType,
      input.platform,
      normalizedAccountName,
      encryptSecret(input.login.trim()),
      encryptSecret(input.password.trim()),
      encryptSecret(input.server.trim()),
      input.accountType === "BROKER" ? input.lotStep ?? 0.01 : 0.01,
      validation?.metaApiAccountId ?? null,
      validation?.connectionState ?? "pending",
      validation?.validationMessage ?? null,
      validation?.connectionStatus ?? null,
      validation?.balance ?? null,
      validation?.equity ?? null,
      validation?.lastValidatedAt ?? null,
    ],
  );

  return mapSavedAccountRow(result.rows[0]!);
}

function deriveBackfillConnectionState(connectionStatus: string | null): SavedAccountConnectionState {
  if (connectionStatus === "CONNECTED") {
    return "connected";
  }

  if (
    connectionStatus === "ACCOUNT_FAILED" ||
    connectionStatus === "BROKER_CONNECTION_FAILED" ||
    connectionStatus === "DISCONNECTED_FROM_BROKER"
  ) {
    return "error";
  }

  return "pending";
}

async function getBillingCountry(client: PoolClient, userId: string) {
  const result = await client.query<{ billing_country: string | null }>(
    `
      select billing_country
      from (
        select billing_country, updated_at
        from subscriptions
        where user_id = $1
          and status = 'ACTIVE'

        union all

        select billing_country, updated_at
        from user_profiles
        where user_id = $1
      ) sources
      where billing_country is not null
      order by updated_at desc nulls last
      limit 1
    `,
    [userId],
  );

  return result.rows[0]?.billing_country ?? null;
}

async function validateSavedAccountConnection(
  savedAccountId: string,
  input: SavedAccountInput,
  existingMetaApiAccountId?: string | null,
  proxyIp?: string | null,
): Promise<SavedAccountValidationInput> {
  const lastValidatedAt = new Date().toISOString();
  let provisionedAccountId = existingMetaApiAccountId ?? null;

  try {
    const provisioned = await provisionMetaApiAccount({
      slotId: `saved_account_${savedAccountId}`,
      accountType: input.accountType,
      platform: input.platform,
      login: input.login.trim(),
      password: input.password.trim(),
      server: input.server.trim(),
      proxyIp: proxyIp ?? undefined,
      existingAccountId: existingMetaApiAccountId,
    });
    provisionedAccountId = provisioned.accountId;

    await waitUntilMetaApiAccountReady(provisioned.accountId, {
      retries: 90,
      delayMs: 2000,
    });

    const metrics = await getMetaApiAccountLiveMetrics(provisioned.accountId);

    return {
      metaApiAccountId: provisioned.accountId,
      connectionState: "connected",
      validationMessage: null,
      connectionStatus: metrics.connectionStatus,
      balance: metrics.balance,
      equity: metrics.equity,
      lastValidatedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connessione MetaApi non riuscita";
    let snapshot:
      | Awaited<ReturnType<typeof getMetaApiAccountConnectionSnapshot>>
      | null = null;

    if (provisionedAccountId) {
      try {
        snapshot = await getMetaApiAccountConnectionSnapshot(provisionedAccountId);
      } catch (snapshotError) {
        logger.warn({ error: snapshotError, savedAccountId }, "Unable to read saved account snapshot after validation error");
      }
    }

    const snapshotStatus = snapshot?.connectionStatus ?? null;
    const isHardFailure =
      isMetaApiConnectionFailureStatus(snapshotStatus) ||
      /invalid|wrong|incorrect|not found|failed/i.test(message);

    return {
      metaApiAccountId: snapshot?.accountId ?? provisionedAccountId ?? null,
      connectionState: isHardFailure ? "error" : "pending",
      validationMessage: isHardFailure
        ? message
        : "Connessione MetaApi in corso...",
      connectionStatus: snapshotStatus,
      balance: null,
      equity: null,
      lastValidatedAt,
    };
  }
}

async function refreshSavedAccountConnection(
  client: PoolClient,
  userId: string,
  row: SavedAccountRow,
) {
  const input: SavedAccountInput = {
    label: row.label,
    accountType: row.account_type,
    platform: row.platform,
    accountName:
      row.account_type === "BROKER"
        ? row.account_name ?? "Broker"
        : row.account_name ?? "FundingPips Prop",
    login: decryptSecret(row.login_ciphertext),
    password: decryptSecret(row.password_ciphertext),
    server: decryptSecret(row.server_ciphertext),
    lotStep: Number(row.broker_lot_step ?? 0.01),
  };

  const lastValidatedAt = new Date().toISOString();

  if (row.metaapi_account_id) {
    try {
      let snapshot = await getMetaApiAccountConnectionSnapshot(row.metaapi_account_id);

      if (
        snapshot.connectionStatus !== "CONNECTED" &&
        !isMetaApiConnectionFailureStatus(snapshot.connectionStatus)
      ) {
        try {
          await waitUntilMetaApiAccountReady(row.metaapi_account_id, {
            retries: 18,
            delayMs: 1500,
          });
          snapshot = await getMetaApiAccountConnectionSnapshot(row.metaapi_account_id);
        } catch {
          // Keep the latest snapshot and let the stale timeout decide if this becomes an error.
        }
      }

      if (snapshot.connectionStatus === "CONNECTED") {
        const metrics = await getMetaApiAccountLiveMetrics(row.metaapi_account_id);
        return await upsertSavedAccountForUser(client, userId, input, {
          preserveExistingLabel: true,
          validation: {
            metaApiAccountId: row.metaapi_account_id,
            connectionState: "connected",
            validationMessage: null,
            connectionStatus: metrics.connectionStatus,
            balance: metrics.balance,
            equity: metrics.equity,
            lastValidatedAt,
          },
        });
      }

      if (isMetaApiConnectionFailureStatus(snapshot.connectionStatus)) {
        return await upsertSavedAccountForUser(client, userId, input, {
          preserveExistingLabel: true,
          validation: {
            metaApiAccountId: row.metaapi_account_id,
            connectionState: "error",
            validationMessage:
              row.validation_message ??
              "MetaApi segnala un problema di connessione. Controlla credenziali e server.",
            connectionStatus: snapshot.connectionStatus,
            balance: null,
            equity: null,
            lastValidatedAt,
          },
        });
      }

      return await upsertSavedAccountForUser(client, userId, input, {
        preserveExistingLabel: true,
        validation: {
          metaApiAccountId: row.metaapi_account_id,
          connectionState: isSavedAccountPendingTooLong(row) ? "error" : "pending",
          validationMessage: isSavedAccountPendingTooLong(row)
            ? "MetaApi non riesce a stabilizzare la connessione. Controlla login, password e server."
            : "Connessione MetaApi in corso...",
          connectionStatus: snapshot.connectionStatus,
          balance: null,
          equity: null,
          lastValidatedAt,
        },
      });
    } catch (error) {
      logger.warn(
        { error, savedAccountId: row.id, metaApiAccountId: row.metaapi_account_id },
        "Unable to refresh saved account from existing MetaApi account, retrying validation",
      );
    }
  }

  const validation = await validateSavedAccountConnection(
    row.id,
    input,
    row.metaapi_account_id,
  );

  return await upsertSavedAccountForUser(client, userId, input, {
    preserveExistingLabel: true,
    validation,
  });
}

export async function listSavedAccountsForUser(userId: string) {
  const client = await pool.connect();
  try {
    await refreshTradingAccountConnectionsForUser(client, userId);

    const backfillResult = await client.query<TradingAccountBackfillRow>(
      `
        select
          ta.account_type,
          ta.platform,
          ta.account_name,
          ta.login_ciphertext,
          ta.password_ciphertext,
          ta.server_ciphertext,
          ta.broker_lot_step::text,
          ta.metaapi_account_id,
          ta.connection_status,
          hs.challenge
        from trading_accounts ta
        left join hedging_slots hs
          on hs.id = ta.slot_id
        where ta.user_id = $1
          and ta.login_ciphertext is not null
          and ta.password_ciphertext is not null
          and ta.server_ciphertext is not null
      `,
      [userId],
    );

    for (const row of backfillResult.rows) {
      if (!row.login_ciphertext || !row.password_ciphertext || !row.server_ciphertext) {
        continue;
      }

      const backfillInput: SavedAccountInput = {
        label:
          row.account_type === "PROP"
            ? row.challenge ?? "FundingPips Prop"
            : row.account_name ?? "Broker",
        accountType: row.account_type,
        platform: row.platform,
        accountName:
          row.account_type === "BROKER"
            ? row.account_name ?? "Broker"
            : "FundingPips Prop",
        login: decryptSecret(row.login_ciphertext),
        password: decryptSecret(row.password_ciphertext),
        server: decryptSecret(row.server_ciphertext),
        lotStep: Number(row.broker_lot_step ?? 0.01),
      };

      const matchingRow = await findMatchingSavedAccountRow(client, userId, backfillInput);
      if (matchingRow?.deleted_at) {
        continue;
      }

      await upsertSavedAccountForUser(
        client,
        userId,
        backfillInput,
        {
          preserveExistingLabel: true,
          validation: {
            metaApiAccountId: row.metaapi_account_id,
            connectionState: deriveBackfillConnectionState(row.connection_status),
            validationMessage: null,
            connectionStatus: row.connection_status,
          },
        },
      );
    }

    const result = await client.query<SavedAccountRow>(
      `
        select
          id,
          label,
          account_type,
          platform,
          account_name,
          login_ciphertext,
          password_ciphertext,
          server_ciphertext,
          broker_lot_step::text,
          metaapi_account_id,
          connection_state,
          validation_message,
          connection_status,
          balance::text,
          equity::text,
          last_validated_at::text,
          deleted_at::text,
          created_at::text
        from saved_accounts
        where user_id = $1
          and deleted_at is null
        order by created_at desc
      `,
      [userId],
    );

    for (const row of result.rows) {
      if (!shouldRefreshPendingSavedAccount(row)) {
        continue;
      }

      try {
        await refreshSavedAccountConnection(client, userId, row);
      } catch (error) {
        logger.warn(
          { error, savedAccountId: row.id, userId },
          "Unable to refresh pending saved account connection",
        );
      }
    }

    const refreshedResult = await client.query<SavedAccountRow>(
      `
        select
          id,
          label,
          account_type,
          platform,
          account_name,
          login_ciphertext,
          password_ciphertext,
          server_ciphertext,
          broker_lot_step::text,
          metaapi_account_id,
          connection_state,
          validation_message,
          connection_status,
          balance::text,
          equity::text,
          last_validated_at::text,
          deleted_at::text,
          created_at::text
        from saved_accounts
        where user_id = $1
          and deleted_at is null
        order by created_at desc
      `,
      [userId],
    );

    return refreshedResult.rows.map(mapSavedAccountRow);
  } finally {
    client.release();
  }
}

export async function createSavedAccount(
  userId: string,
  input: SavedAccountInput,
  options?: {
    email?: string;
  },
) {
  const client = await pool.connect();
  try {
    const isAdminUser =
      typeof options?.email === "string" &&
      adminEmails.has(options.email.trim().toLowerCase());

    const billingCountry = isAdminUser ? null : await getBillingCountry(client, userId);

    if (!isAdminUser) {
      await assertAvailableSeatForUser(
        client,
        userId,
        "Ti serve almeno uno slot pagato e disponibile prima di collegare nuovi conti.",
      );
    }

    const proxy = isAdminUser
      ? await getAssignedProxyForUser(userId, client)
      : await assignDedicatedProxyForUser({
          client,
          userId,
          billingCountry,
        });

    const pendingAccount = await upsertSavedAccountForUser(
      client,
      userId,
      input,
      {
        validation: {
          connectionState: "pending",
          validationMessage: "Validazione MetaApi in corso...",
          lastValidatedAt: new Date().toISOString(),
        },
      },
    );

    const validation = await validateSavedAccountConnection(
      pendingAccount.id,
      input,
      (pendingAccount as SavedAccountSnapshot & { metaApiAccountId?: string | null })
        .metaApiAccountId ?? null,
      proxy?.ipAddress ?? null,
    );

    return await upsertSavedAccountForUser(client, userId, input, {
      preserveExistingLabel: true,
      validation,
    });
  } finally {
    client.release();
  }
}

export async function getSavedAccountForImport(
  client: PoolClient,
  userId: string,
  savedAccountId: string,
  accountType: TradingAccountType,
) {
  const result = await client.query<SavedAccountRow>(
    `
      select
        id,
        label,
        account_type,
        platform,
        account_name,
        login_ciphertext,
        password_ciphertext,
        server_ciphertext,
        broker_lot_step::text,
        metaapi_account_id,
        connection_state,
        validation_message,
        connection_status,
        balance::text,
        equity::text,
        last_validated_at::text,
        deleted_at::text,
        created_at::text
      from saved_accounts
      where id = $1 and user_id = $2 and account_type = $3 and deleted_at is null
      limit 1
    `,
    [savedAccountId, userId, accountType],
  );

  if (!result.rowCount) {
    throw new Error(`Saved ${accountType.toLowerCase()} account not found`);
  }

  const row = result.rows[0]!;

  return {
    id: row.id,
    label: row.label,
    accountType: row.account_type,
    platform: row.platform,
    accountName:
      row.account_type === "BROKER"
        ? row.account_name ?? "Broker"
        : row.account_name ?? "FundingPips Prop",
    lotStep: Number(row.broker_lot_step ?? 0.01),
    login: decryptSecret(row.login_ciphertext),
    password: decryptSecret(row.password_ciphertext),
    server: decryptSecret(row.server_ciphertext),
    metaApiAccountId: row.metaapi_account_id,
    connectionState: row.connection_state,
    balance: row.balance === null ? null : Number(row.balance),
    equity: row.equity === null ? null : Number(row.equity),
  };
}
