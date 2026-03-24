import type { PoolClient } from "pg";
import type { SavedAccountSnapshot, TradingAccountType } from "@deltahedge/shared";
import { pool } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto-service.js";

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
    createdAt: row.created_at,
  };
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
        created_at
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
  options?: { preserveExistingLabel?: boolean },
) {
  const normalizedAccountName =
    input.accountType === "BROKER"
      ? input.accountName?.trim() || "Broker"
      : input.accountName?.trim() || "FundingPips Prop";
  const matchingRow = await findMatchingSavedAccountRow(client, userId, input);

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
          created_at
      `,
      [
        matchingRow.id,
        label,
        normalizedAccountName,
        encryptSecret(input.login.trim()),
        encryptSecret(input.password.trim()),
        encryptSecret(input.server.trim()),
        input.accountType === "BROKER" ? input.lotStep ?? 0.01 : 0.01,
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
        broker_lot_step
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        created_at
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
    ],
  );

  return mapSavedAccountRow(result.rows[0]!);
}

export async function listSavedAccountsForUser(userId: string) {
  const client = await pool.connect();
  try {
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

      await upsertSavedAccountForUser(
        client,
        userId,
        {
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
        },
        { preserveExistingLabel: true },
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
          created_at
        from saved_accounts
        where user_id = $1
        order by created_at desc
      `,
      [userId],
    );

    return result.rows.map(mapSavedAccountRow);
  } finally {
    client.release();
  }
}

export async function createSavedAccount(
  userId: string,
  input: SavedAccountInput,
) {
  const client = await pool.connect();
  try {
    return await upsertSavedAccountForUser(client, userId, input);
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
        created_at
      from saved_accounts
      where id = $1 and user_id = $2 and account_type = $3
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
  };
}
