import type { PoolClient } from "pg";
import {
  buildCycleProjection,
  getEffectiveCycleTarget,
  getEffectiveMultiplier,
  type ChallengeName,
  type SlotAccountConnectionState,
  type SlotSnapshot,
  type TradeDirection,
} from "@deltahedge/shared";
import { adminEmails } from "../config.js";
import { pool } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto-service.js";
import {
  ensureSingleMetaApiAccount,
  getMetaApiAccountConnectionSnapshot,
  getMetaApiAccountLiveMetrics,
  provisionMetaApiAccount,
} from "./metaapi-service.js";
import { assignDedicatedProxyForUser } from "./proxy-service.js";
import { publishRuntimeEvent } from "./runtime-events.js";
import {
  allocateSeatForSlot,
  getSeatAvailabilityForUser,
  releaseSeatForSlot,
} from "./seat-service.js";
import {
  getSavedAccountForImport,
  upsertSavedAccountForUser,
} from "./account-library-service.js";

type SlotRow = {
  id: string;
  slot_name: string;
  challenge: ChallengeName;
  phase: "Fase 1" | "Fase 2" | "Funded";
  runtime_status:
    | "DRAFT"
    | "READY"
    | "RUNNING"
    | "PAUSED_MANUAL"
    | "PAUSED_BILLING"
    | "FUNDED_BREAK_EVEN_READY";
  cycle_state:
    | "FASE_1_ACTIVE"
    | "FASE_1_PASSED"
    | "FASE_1_FAILED"
    | "FASE_2_ACTIVE"
    | "FASE_2_PASSED"
    | "FASE_2_FAILED"
    | "FUNDED_ACTIVE"
    | "FUNDED_FAILED"
    | "FUNDED_PAYOUT"
    | "FUNDED_BREAK_EVEN_READY"
    | "PAUSED_BILLING";
  broker_account_name: string | null;
  prop_deployment_state: string | null;
  broker_deployment_state: string | null;
  prop_connection_status: string | null;
  broker_connection_status: string | null;
  parameters_profile: string | null;
  phase1_base_target: string | null;
  broker_start_equity: string | null;
  risk_per_trade: string | null;
  max_daily_trades: number | null;
  orphan_timeout_ms: number | null;
  current_target: string | null;
  current_multiplier: string | null;
  cycle_balance: number | null;
  prop_equity: string | null;
  broker_equity: string | null;
  prop_unrealized_pnl: string | null;
  broker_unrealized_pnl: string | null;
  updated_at: string;
  prop_account_id: string | null;
  broker_account_id: string | null;
  prop_platform: "mt4" | "mt5" | null;
  broker_platform: "mt4" | "mt5" | null;
  prop_login_ciphertext: string | null;
  prop_server_ciphertext: string | null;
  broker_login_ciphertext: string | null;
  broker_server_ciphertext: string | null;
};

type StoredTradingAccountRow = {
  account_type: "PROP" | "BROKER";
  platform: "mt4" | "mt5";
  metaapi_account_id: string | null;
  login_ciphertext: string | null;
  password_ciphertext: string | null;
  server_ciphertext: string | null;
  broker_lot_step: string | null;
  account_name: string | null;
};

type ReusableTradingAccountRow = {
  metaapi_account_id: string | null;
  platform: "mt4" | "mt5";
  login_ciphertext: string | null;
  password_ciphertext: string | null;
  server_ciphertext: string | null;
};

type SlotParametersRuntimeRow = {
  challenge: ChallengeName;
  phase: "Fase 1" | "Fase 2" | "Funded";
  broker_start_equity: string | null;
  broker_equity: string | null;
  broker_metaapi_account_id: string | null;
};

function sameEncryptedSecret(ciphertext: string | null, plain: string) {
  if (!ciphertext) return false;
  return decryptSecret(ciphertext) === plain;
}

async function reuseOrProvisionMetaAccount(
  mode: "reuse" | "provision",
  input: Parameters<typeof provisionMetaApiAccount>[0],
  existingAccountId?: string | null,
) {
  if (mode === "reuse" && existingAccountId) {
    try {
      const snapshot = await getMetaApiAccountConnectionSnapshot(existingAccountId);
      await ensureSingleMetaApiAccount(input, snapshot.accountId);
      return {
        accountId: snapshot.accountId,
        deploymentState:
          snapshot.deploymentState === "UNKNOWN" ? "NOT_DEPLOYED" : snapshot.deploymentState,
        connectionStatus: snapshot.connectionStatus,
      };
    } catch {
      // If the stored id is stale, recreate/update once.
    }
  }

  return provisionMetaApiAccount(input);
}

async function findReusableTradingAccountForUser(
  client: PoolClient,
  userId: string,
  accountType: "PROP" | "BROKER",
  resolved: {
    platform: "mt4" | "mt5";
    login: string;
    password: string;
    server: string;
  },
) {
  const result = await client.query<ReusableTradingAccountRow>(
    `
      select
        metaapi_account_id,
        platform,
        login_ciphertext,
        password_ciphertext,
        server_ciphertext
      from trading_accounts
      where user_id = $1
        and account_type = $2
        and metaapi_account_id is not null
    `,
    [userId, accountType],
  );

  return (
    result.rows.find((row) => {
      return (
        row.metaapi_account_id &&
        row.platform === resolved.platform &&
        sameEncryptedSecret(row.login_ciphertext, resolved.login) &&
        sameEncryptedSecret(row.password_ciphertext, resolved.password) &&
        sameEncryptedSecret(row.server_ciphertext, resolved.server)
      );
    }) ?? null
  );
}

function maskLogin(login: string) {
  if (!login) return "";
  if (login.length <= 4) return login;
  return `${login.slice(0, 2)}•••${login.slice(-2)}`;
}

function deriveConnectionState(
  accountId: string | null,
  deploymentState: string | null,
  connectionStatus: string | null,
): SlotAccountConnectionState {
  if (!accountId) return "empty";
  if (connectionStatus === "CONNECTED") return "connected";
  if (
    connectionStatus === "ACCOUNT_FAILED" ||
    connectionStatus === "BROKER_CONNECTION_FAILED" ||
    connectionStatus === "DISCONNECTED_FROM_BROKER"
  ) {
    return "disconnected";
  }
  if (
    deploymentState === "CREATED" ||
    deploymentState === "DEPLOYING" ||
    deploymentState === "DEPLOYED" ||
    connectionStatus === "DISCONNECTED" ||
    connectionStatus === "UNKNOWN" ||
    !connectionStatus
  ) {
    return "connecting";
  }
  return "disconnected";
}

function mapSlotRowToSnapshot(row: SlotRow): SlotSnapshot {
  const propConnected = Boolean(row.prop_account_id);
  const brokerConnected = Boolean(row.broker_account_id);
  const propConnectionState = deriveConnectionState(
    row.prop_account_id,
    row.prop_deployment_state,
    row.prop_connection_status,
  );
  const brokerConnectionState = deriveConnectionState(
    row.broker_account_id,
    row.broker_deployment_state,
    row.broker_connection_status,
  );
  const hasParameters = Boolean(row.parameters_profile);
  const metaApiStatus =
    propConnectionState === "connected" && brokerConnectionState === "connected"
      ? "ready"
      : propConnected || brokerConnected
        ? "partial"
        : "empty";

  const challengeState:
    | "BOZZA"
    | "PRONTA"
    | "ATTIVA"
    | "PAUSA_BILLING"
    | "AVAILABLE" =
    row.cycle_state === "FASE_1_FAILED" ||
    row.cycle_state === "FASE_2_FAILED" ||
    row.cycle_state === "FUNDED_FAILED"
      ? "AVAILABLE"
      : row.runtime_status === "RUNNING"
      ? "ATTIVA"
      : row.runtime_status === "PAUSED_BILLING"
        ? "PAUSA_BILLING"
        : propConnected && brokerConnected && hasParameters
          ? "PRONTA"
          : "BOZZA";

  const phase1BaseTarget = Number(row.phase1_base_target ?? 0);
  const brokerStartEquity = Number(row.broker_start_equity ?? row.broker_equity ?? 0);
  const target =
    Number(row.current_target ?? 0) ||
    getEffectiveCycleTarget({
      challenge: row.challenge,
      phase: row.phase,
      phase1BaseTarget,
    });
  const multiplier =
    Number(row.current_multiplier ?? 0) ||
    getEffectiveMultiplier({
      challenge: row.challenge,
      phase: row.phase,
      phase1BaseTarget,
    });

  return {
    id: row.id,
    slot: row.slot_name,
    challenge: row.challenge,
    phase: row.phase,
    status: row.phase === "Funded" ? "FUNDED" : row.phase === "Fase 2" ? "PRACTITIONER" : "OPEN",
    cycleState: row.cycle_state,
    challengeState,
    parametersProfile: row.parameters_profile ?? "",
    brokerAccount: row.broker_account_name ?? "",
    propPlatform: row.prop_platform ?? "mt5",
    brokerPlatform: row.broker_platform ?? "mt5",
    propLoginMasked: row.prop_login_ciphertext
      ? maskLogin(decryptSecret(row.prop_login_ciphertext))
      : "",
    brokerLoginMasked: row.broker_login_ciphertext
      ? maskLogin(decryptSecret(row.broker_login_ciphertext))
      : "",
    propServerHint: row.prop_server_ciphertext
      ? decryptSecret(row.prop_server_ciphertext)
      : "",
    brokerServerHint: row.broker_server_ciphertext
      ? decryptSecret(row.broker_server_ciphertext)
      : "",
    propConnectionState,
    brokerConnectionState,
    propConnected,
    brokerConnected,
    metaApiStatus,
    propEquity: Number(row.prop_equity ?? 0),
    brokerEquity: Number(row.broker_equity ?? brokerStartEquity),
    propUnrealizedPnl:
      row.prop_unrealized_pnl === null || row.prop_unrealized_pnl === undefined
        ? null
        : Number(row.prop_unrealized_pnl),
    brokerUnrealizedPnl:
      row.broker_unrealized_pnl === null || row.broker_unrealized_pnl === undefined
        ? null
        : Number(row.broker_unrealized_pnl),
    target,
    hedgeBaseTarget: phase1BaseTarget,
    multiplier,
    brokerStartEquity,
    cycleBalance: Number(row.cycle_balance ?? 0),
    riskPerTrade: Number(row.risk_per_trade ?? 1.5),
    maxDailyTrades: Number(row.max_daily_trades ?? 2),
    orphanTimeoutMs: Number(row.orphan_timeout_ms ?? 1000),
    updatedAt: new Date(row.updated_at).toLocaleTimeString("it-IT", {
      hour: "2-digit",
      minute: "2-digit",
    }),
  } as SlotSnapshot;
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

async function querySlotsByUser(client: PoolClient, userId: string) {
  const result = await client.query<SlotRow>(
    `
      select
        hs.id,
        hs.slot_name,
        hs.challenge,
        hs.phase,
        hs.runtime_status,
        hs.cycle_state,
        hs.broker_account_name,
        hs.updated_at,
        prop.id as prop_account_id,
        broker.id as broker_account_id,
        prop.platform as prop_platform,
        broker.platform as broker_platform,
        prop.login_ciphertext as prop_login_ciphertext,
        prop.server_ciphertext as prop_server_ciphertext,
        broker.login_ciphertext as broker_login_ciphertext,
        broker.server_ciphertext as broker_server_ciphertext,
        prop.deployment_state as prop_deployment_state,
        broker.deployment_state as broker_deployment_state,
        prop.connection_status as prop_connection_status,
        broker.connection_status as broker_connection_status,
        sp.parameters_profile,
        sp.phase1_base_target,
        sp.broker_start_equity,
        sp.risk_per_trade,
        sp.max_daily_trades,
        sp.orphan_timeout_ms,
        sr.current_target,
        sr.current_multiplier,
        sr.cycle_balance,
        sr.prop_equity,
        sr.broker_equity
      from hedging_slots hs
      left join trading_accounts prop
        on prop.slot_id = hs.id and prop.account_type = 'PROP'
      left join trading_accounts broker
        on broker.slot_id = hs.id and broker.account_type = 'BROKER'
      left join slot_parameters sp
        on sp.slot_id = hs.id
      left join slot_runtime sr
        on sr.slot_id = hs.id
      where hs.user_id = $1
      order by hs.created_at desc
    `,
    [userId],
  );

  return result.rows.map(mapSlotRowToSnapshot);
}

export async function listSlotsForUser(userId: string) {
  const client = await pool.connect();
  try {
    const slots = await querySlotsByUser(client, userId);
    const subscriptionResult = await client.query<{
      plan_name: string;
      cadence: string;
      renewal_date: string | null;
    }>(
      `
        select plan_name, cadence, renewal_date
        from subscriptions
        where user_id = $1 and status = 'ACTIVE'
        order by updated_at desc
        limit 1
      `,
      [userId],
    );
    const seatAvailability = await getSeatAvailabilityForUser(client, userId);

    return {
      slots,
      subscription: {
        planName: subscriptionResult.rows[0]?.plan_name ?? "Nessun piano",
        billingCadence: subscriptionResult.rows[0]?.cadence ?? "Mensile",
        renewalDate: subscriptionResult.rows[0]?.renewal_date
          ? new Date(subscriptionResult.rows[0].renewal_date).toLocaleDateString("it-IT")
          : "In attesa",
        slotsIncluded: seatAvailability.slotsIncluded,
        usedSlots: seatAvailability.usedSlots,
        availableSlots: seatAvailability.availableSlots,
        canCreateSlot: seatAvailability.availableSlots > 0,
        canManageAccounts: seatAvailability.availableSlots > 0,
      },
    };
  } finally {
    client.release();
  }
}

export async function getSlotById(userId: string, slotId: string) {
  const client = await pool.connect();
  try {
    const slots = await querySlotsByUser(client, userId);
    const slot = slots.find((item) => item.id === slotId);
    if (!slot) {
      throw new Error("Slot not found");
    }
    return slot;
  } finally {
    client.release();
  }
}

export async function createSlot(
  userId: string,
  input: { slot: string; challenge: ChallengeName; phase: "Fase 1" | "Fase 2" | "Funded" },
  options?: {
    email?: string;
  },
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const isAdminUser =
      typeof options?.email === "string" &&
      adminEmails.has(options.email.trim().toLowerCase());
    const nextCycleState =
      input.phase === "Fase 1"
        ? "FASE_1_ACTIVE"
        : input.phase === "Fase 2"
          ? "FASE_2_ACTIVE"
          : "FUNDED_ACTIVE";
    const slotResult = await client.query<{ id: string; updated_at: string }>(
      `
        insert into hedging_slots (user_id, slot_name, challenge, phase, runtime_status, cycle_state)
        values ($1, $2, $3, $4, 'DRAFT', $5)
        returning id, updated_at
      `,
      [userId, input.slot, input.challenge, input.phase, nextCycleState],
    );
    const slotId = slotResult.rows[0]!.id;
    if (!isAdminUser) {
      const seatId = await allocateSeatForSlot(client, userId, slotId);
      await client.query(
        `
          update hedging_slots
          set seat_id = $2,
              cycle_state = $3
          where id = $1
        `,
        [slotId, seatId, nextCycleState],
      );
    }
    await client.query(
      `
        insert into slot_runtime (slot_id)
        values ($1)
      `,
      [slotId],
    );
    await client.query("commit");

    const slot = await getSlotById(userId, slotId);
    await publishRuntimeEvent({
      event: "slot.updated",
      userId,
      slotId,
      payload: slot,
      emittedAt: new Date().toISOString(),
    });
    return slot;
  } catch (error) {
    await client.query("rollback");
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      "constraint" in error &&
      (error as { code?: string }).code === "23505" &&
      (error as { constraint?: string }).constraint === "hedging_slots_user_slot_name_idx"
    ) {
      throw new Error("Esiste gia uno slot con questo nome. Scegli un nome diverso.");
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertSlotAccounts(
  userId: string,
  slotId: string,
  input: {
    challenge: ChallengeName;
    prop: {
      savedAccountId?: string | null;
      platform?: "mt4" | "mt5";
      login: string;
      password: string;
      server: string;
    };
    broker: {
      accountName: string;
      savedAccountId?: string | null;
      platform?: "mt4" | "mt5";
      login: string;
      password: string;
      server: string;
      lotStep: number;
    };
  },
  options?: {
    email?: string;
  },
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const isAdminUser =
      typeof options?.email === "string" &&
      adminEmails.has(options.email.trim().toLowerCase());
    const billingCountry = await getBillingCountry(client, userId);
    const proxy = isAdminUser
      ? null
      : await assignDedicatedProxyForUser({
          client,
          userId,
          billingCountry,
        });

    const existingAccounts = await client.query<StoredTradingAccountRow>(
      `
        select
          account_type,
          platform,
          metaapi_account_id,
          login_ciphertext,
          password_ciphertext,
          server_ciphertext,
          broker_lot_step::text,
          account_name
        from trading_accounts
        where user_id = $1 and slot_id = $2
      `,
      [userId, slotId],
    );

    const existingPropAccount = existingAccounts.rows.find(
      (row) => row.account_type === "PROP",
    );
    const existingBrokerAccount = existingAccounts.rows.find(
      (row) => row.account_type === "BROKER",
    );

    const savedPropAccount = input.prop.savedAccountId
      ? await getSavedAccountForImport(client, userId, input.prop.savedAccountId, "PROP")
      : null;
    const savedBrokerAccount = input.broker.savedAccountId
      ? await getSavedAccountForImport(client, userId, input.broker.savedAccountId, "BROKER")
      : null;

    const resolvedProp = {
      platform:
        input.prop.platform ??
        savedPropAccount?.platform ??
        existingPropAccount?.platform ??
        "mt5",
      login:
        input.prop.login.trim() ||
        savedPropAccount?.login ||
        (existingPropAccount?.login_ciphertext
          ? decryptSecret(existingPropAccount.login_ciphertext)
          : ""),
      password:
        input.prop.password.trim() ||
        savedPropAccount?.password ||
        (existingPropAccount?.password_ciphertext
          ? decryptSecret(existingPropAccount.password_ciphertext)
          : ""),
      server:
        input.prop.server.trim() ||
        savedPropAccount?.server ||
        (existingPropAccount?.server_ciphertext
          ? decryptSecret(existingPropAccount.server_ciphertext)
          : ""),
    };

    const resolvedBroker = {
      accountName:
        input.broker.accountName.trim() ||
        savedBrokerAccount?.accountName ||
        existingBrokerAccount?.account_name ||
        "Broker",
      platform:
        input.broker.platform ??
        savedBrokerAccount?.platform ??
        existingBrokerAccount?.platform ??
        "mt5",
      login:
        input.broker.login.trim() ||
        savedBrokerAccount?.login ||
        (existingBrokerAccount?.login_ciphertext
          ? decryptSecret(existingBrokerAccount.login_ciphertext)
          : ""),
      password:
        input.broker.password.trim() ||
        savedBrokerAccount?.password ||
        (existingBrokerAccount?.password_ciphertext
          ? decryptSecret(existingBrokerAccount.password_ciphertext)
          : ""),
      server:
        input.broker.server.trim() ||
        savedBrokerAccount?.server ||
        (existingBrokerAccount?.server_ciphertext
          ? decryptSecret(existingBrokerAccount.server_ciphertext)
          : ""),
      lotStep:
        input.broker.lotStep ||
        savedBrokerAccount?.lotStep ||
        Number(existingBrokerAccount?.broker_lot_step ?? 0.01),
    };

    if (!resolvedProp.login || !resolvedProp.password || !resolvedProp.server) {
      throw new Error("Missing prop credentials");
    }

    if (!resolvedBroker.login || !resolvedBroker.password || !resolvedBroker.server) {
      throw new Error("Missing broker credentials");
    }

    const propUnchanged =
      Boolean(existingPropAccount?.metaapi_account_id) &&
      existingPropAccount?.platform === resolvedProp.platform &&
      sameEncryptedSecret(existingPropAccount?.login_ciphertext ?? null, resolvedProp.login) &&
      sameEncryptedSecret(existingPropAccount?.password_ciphertext ?? null, resolvedProp.password) &&
      sameEncryptedSecret(existingPropAccount?.server_ciphertext ?? null, resolvedProp.server);

    const brokerUnchanged =
      Boolean(existingBrokerAccount?.metaapi_account_id) &&
      existingBrokerAccount?.platform === resolvedBroker.platform &&
      sameEncryptedSecret(existingBrokerAccount?.login_ciphertext ?? null, resolvedBroker.login) &&
      sameEncryptedSecret(
        existingBrokerAccount?.password_ciphertext ?? null,
        resolvedBroker.password,
      ) &&
      sameEncryptedSecret(existingBrokerAccount?.server_ciphertext ?? null, resolvedBroker.server);

    const reusablePropTradingAccount = await findReusableTradingAccountForUser(
      client,
      userId,
      "PROP",
      {
        platform: resolvedProp.platform,
        login: resolvedProp.login,
        password: resolvedProp.password,
        server: resolvedProp.server,
      },
    );

    const reusableBrokerTradingAccount = await findReusableTradingAccountForUser(
      client,
      userId,
      "BROKER",
      {
        platform: resolvedBroker.platform,
        login: resolvedBroker.login,
        password: resolvedBroker.password,
        server: resolvedBroker.server,
      },
    );

    const propMetaApiAccountId =
      existingPropAccount?.metaapi_account_id ??
      savedPropAccount?.metaApiAccountId ??
      reusablePropTradingAccount?.metaapi_account_id ??
      null;
    const brokerMetaApiAccountId =
      existingBrokerAccount?.metaapi_account_id ??
      savedBrokerAccount?.metaApiAccountId ??
      reusableBrokerTradingAccount?.metaapi_account_id ??
      null;

    const propMeta = await reuseOrProvisionMetaAccount(
      propUnchanged || Boolean(reusablePropTradingAccount?.metaapi_account_id)
        ? "reuse"
        : "provision",
      {
        slotId,
        accountType: "PROP",
        platform: resolvedProp.platform,
        login: resolvedProp.login,
        password: resolvedProp.password,
        server: resolvedProp.server,
        proxyIp: proxy?.ipAddress,
        existingAccountId: propMetaApiAccountId,
      },
      propMetaApiAccountId,
    );
    const brokerMeta = await reuseOrProvisionMetaAccount(
      brokerUnchanged || Boolean(reusableBrokerTradingAccount?.metaapi_account_id)
        ? "reuse"
        : "provision",
      {
        slotId,
        accountType: "BROKER",
        platform: resolvedBroker.platform,
        login: resolvedBroker.login,
        password: resolvedBroker.password,
        server: resolvedBroker.server,
        proxyIp: proxy?.ipAddress,
        existingAccountId: brokerMetaApiAccountId,
      },
      brokerMetaApiAccountId,
    );

    const [propMetrics, brokerMetrics] = await Promise.all([
      getMetaApiAccountLiveMetrics(propMeta.accountId).catch(() => null),
      getMetaApiAccountLiveMetrics(brokerMeta.accountId).catch(() => null),
    ]);

    await upsertSavedAccountForUser(
      client,
      userId,
      {
        label: input.challenge,
        accountType: "PROP",
        platform: resolvedProp.platform,
        accountName: "FundingPips Prop",
        login: resolvedProp.login,
        password: resolvedProp.password,
        server: resolvedProp.server,
        lotStep: 0.01,
      },
      {
        preserveExistingLabel: true,
        validation: {
          metaApiAccountId: propMeta.accountId,
          connectionState:
            propMeta.connectionStatus === "CONNECTED" ? "connected" : "pending",
          validationMessage:
            propMeta.connectionStatus === "CONNECTED"
              ? null
              : "Conto salvato ma non ancora connesso stabilmente a MetaApi.",
          connectionStatus: propMetrics?.connectionStatus ?? propMeta.connectionStatus,
          balance: propMetrics?.balance ?? null,
          equity: propMetrics?.equity ?? null,
          lastValidatedAt: new Date().toISOString(),
        },
      },
    );

    await upsertSavedAccountForUser(
      client,
      userId,
      {
        label: resolvedBroker.accountName || "Broker",
        accountType: "BROKER",
        platform: resolvedBroker.platform,
        accountName: resolvedBroker.accountName,
        login: resolvedBroker.login,
        password: resolvedBroker.password,
        server: resolvedBroker.server,
        lotStep: resolvedBroker.lotStep,
      },
      {
        preserveExistingLabel: true,
        validation: {
          metaApiAccountId: brokerMeta.accountId,
          connectionState:
            brokerMeta.connectionStatus === "CONNECTED" ? "connected" : "pending",
          validationMessage:
            brokerMeta.connectionStatus === "CONNECTED"
              ? null
              : "Conto salvato ma non ancora connesso stabilmente a MetaApi.",
          connectionStatus: brokerMetrics?.connectionStatus ?? brokerMeta.connectionStatus,
          balance: brokerMetrics?.balance ?? null,
          equity: brokerMetrics?.equity ?? null,
          lastValidatedAt: new Date().toISOString(),
        },
      },
    );

    await client.query(
      `
        insert into trading_accounts (
          user_id, slot_id, account_type, account_name,
          platform,
          login_ciphertext, password_ciphertext, server_ciphertext,
          metaapi_account_id, deployment_state, connection_status
        )
        values ($1, $2, 'PROP', 'FundingPips Prop', $3, $4, $5, $6, $7, $8, $9)
        on conflict (slot_id, account_type)
        do update set
          platform = excluded.platform,
          login_ciphertext = excluded.login_ciphertext,
          password_ciphertext = excluded.password_ciphertext,
          server_ciphertext = excluded.server_ciphertext,
          metaapi_account_id = excluded.metaapi_account_id,
          deployment_state = excluded.deployment_state,
          connection_status = excluded.connection_status,
          updated_at = now()
      `,
      [
        userId,
        slotId,
        resolvedProp.platform,
        encryptSecret(resolvedProp.login),
        encryptSecret(resolvedProp.password),
        encryptSecret(resolvedProp.server),
        propMeta.accountId,
        propMeta.deploymentState,
        propMeta.connectionStatus,
      ],
    );

    await client.query(
      `
        insert into trading_accounts (
          user_id, slot_id, account_type, account_name,
          platform,
          login_ciphertext, password_ciphertext, server_ciphertext,
          broker_lot_step, metaapi_account_id, deployment_state, connection_status
        )
        values ($1, $2, 'BROKER', $3, $4, $5, $6, $7, $8, $9, $10, $11)
        on conflict (slot_id, account_type)
        do update set
          account_name = excluded.account_name,
          platform = excluded.platform,
          login_ciphertext = excluded.login_ciphertext,
          password_ciphertext = excluded.password_ciphertext,
          server_ciphertext = excluded.server_ciphertext,
          broker_lot_step = excluded.broker_lot_step,
          metaapi_account_id = excluded.metaapi_account_id,
          deployment_state = excluded.deployment_state,
          connection_status = excluded.connection_status,
          updated_at = now()
      `,
      [
        userId,
        slotId,
        resolvedBroker.accountName,
        resolvedBroker.platform,
        encryptSecret(resolvedBroker.login),
        encryptSecret(resolvedBroker.password),
        encryptSecret(resolvedBroker.server),
        resolvedBroker.lotStep,
        brokerMeta.accountId,
        brokerMeta.deploymentState,
        brokerMeta.connectionStatus,
      ],
    );

    await client.query(
      `
        update hedging_slots
        set challenge = $3,
            broker_account_name = $4,
            billing_country = $5,
            proxy_id = $6,
            updated_at = now()
        where id = $1 and user_id = $2
      `,
      [
        slotId,
        userId,
        input.challenge,
        resolvedBroker.accountName,
        billingCountry,
        proxy?.id ?? null,
      ],
    );

    await client.query(
      `
        update slot_runtime
        set prop_equity = coalesce($2, prop_equity),
            broker_equity = coalesce($3, broker_equity),
            updated_at = now()
        where slot_id = $1
      `,
      [
        slotId,
        propMetrics?.equity ?? propMetrics?.balance ?? null,
        brokerMetrics?.equity ?? brokerMetrics?.balance ?? null,
      ],
    );

    await client.query("commit");

    const slot = await getSlotById(userId, slotId);
    await publishRuntimeEvent({
      event: "slot.updated",
      userId,
      slotId,
      payload: slot,
      emittedAt: new Date().toISOString(),
    });
    return slot;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getStoredSlotAccounts(userId: string, slotId: string) {
  const client = await pool.connect();
  try {
    const result = await client.query<StoredTradingAccountRow>(
      `
        select
          account_type,
          platform,
          metaapi_account_id,
          login_ciphertext,
          password_ciphertext,
          server_ciphertext,
          broker_lot_step::text,
          account_name
        from trading_accounts
        where user_id = $1 and slot_id = $2
      `,
      [userId, slotId],
    );

    const prop = result.rows.find((row) => row.account_type === "PROP");
    const broker = result.rows.find((row) => row.account_type === "BROKER");

    return {
      prop: prop
        ? {
            metaapiAccountId: prop.metaapi_account_id,
            platform: prop.platform,
            login: decryptSecret(prop.login_ciphertext!),
            password: decryptSecret(prop.password_ciphertext!),
            server: decryptSecret(prop.server_ciphertext!),
          }
        : null,
      broker: broker
        ? {
            metaapiAccountId: broker.metaapi_account_id,
            platform: broker.platform,
            accountName: broker.account_name ?? "Broker",
            lotStep: Number(broker.broker_lot_step ?? 0.01),
            login: decryptSecret(broker.login_ciphertext!),
            password: decryptSecret(broker.password_ciphertext!),
            server: decryptSecret(broker.server_ciphertext!),
          }
        : null,
    };
  } finally {
    client.release();
  }
}

export async function recordOpenedTradePair(
  userId: string,
  slotId: string,
  input: {
    phase: "Fase 1" | "Fase 2" | "Funded";
    symbol: string;
    direction: TradeDirection;
    propTicketId?: string | null;
    brokerTicketId?: string | null;
    propLotSize: number;
    brokerLotRaw: number;
    brokerLotFinal: number;
  },
) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const openTrade = await client.query<{ id: string }>(
      `
        select id
        from trade_pairs
        where user_id = $1
          and slot_id = $2
          and status in ('PENDING', 'OPEN')
        limit 1
      `,
      [userId, slotId],
    );

    if (openTrade.rowCount) {
      throw new Error("This slot already has an open trade pair");
    }

    const tradeResult = await client.query<{
      id: string;
      phase: "Fase 1" | "Fase 2" | "Funded";
      symbol: string;
      direction: TradeDirection;
      prop_lot_size: string;
      broker_lot_final: string;
    }>(
      `
        insert into trade_pairs (
          user_id, slot_id, phase, symbol, direction, status,
          prop_ticket_id, broker_ticket_id,
          prop_lot_size, broker_lot_raw, broker_lot_final,
          open_time
        )
        values ($1, $2, $3, $4, $5, 'OPEN', $6, $7, $8, $9, $10, now())
        returning id, phase, symbol, direction, prop_lot_size, broker_lot_final
      `,
      [
        userId,
        slotId,
        input.phase,
        input.symbol,
        input.direction,
        input.propTicketId ?? null,
        input.brokerTicketId ?? null,
        input.propLotSize,
        input.brokerLotRaw,
        input.brokerLotFinal,
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
      [slotId, trade.id],
    );

    await client.query("commit");

    await publishRuntimeEvent({
      event: "trade_pair.opened",
      userId,
      slotId,
      payload: {
        id: trade.id,
        phase: trade.phase,
        symbol: trade.symbol,
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

export async function getOpenTradePairForSlot(userId: string, slotId: string) {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: string;
      symbol: string;
      direction: TradeDirection;
      phase: "Fase 1" | "Fase 2" | "Funded";
      open_time: string | null;
    }>(
      `
        select id, symbol, direction, phase, open_time
        from trade_pairs
        where user_id = $1
          and slot_id = $2
          and status in ('PENDING', 'OPEN')
        order by created_at desc
        limit 1
      `,
      [userId, slotId],
    );

    return result.rows[0] ?? null;
  } finally {
    client.release();
  }
}

export async function closeOpenTradePairForSlot(
  userId: string,
  slotId: string,
  options?: {
    tradePairId?: string | null;
    reason?: string;
  },
) {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const existingTrade = options?.tradePairId
      ? await client.query<{ id: string }>(
          `
            select id
            from trade_pairs
            where id = $1
              and user_id = $2
              and slot_id = $3
              and status in ('PENDING', 'OPEN')
            limit 1
          `,
          [options.tradePairId, userId, slotId],
        )
      : await client.query<{ id: string }>(
          `
            select id
            from trade_pairs
            where user_id = $1
              and slot_id = $2
              and status in ('PENDING', 'OPEN')
            order by created_at desc
            limit 1
          `,
          [userId, slotId],
        );

    if (!existingTrade.rowCount) {
      await client.query("rollback");
      return null;
    }

    const tradePairId = existingTrade.rows[0]!.id;

    await client.query(
      `
        update trade_pairs
        set status = 'CLOSED',
            close_time = now(),
            updated_at = now()
        where id = $1
      `,
      [tradePairId],
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

    if (options?.reason) {
      await client.query(
        `
          insert into risk_events (user_id, slot_id, severity, event_type, message, metadata)
          values ($1, $2, 'info', 'FORCED_CLOSE', $3, $4::jsonb)
        `,
        [
          userId,
          slotId,
          options.reason,
          JSON.stringify({
            tradePairId,
            reason: options.reason,
          }),
        ],
      );
    }

    await client.query("commit");
    return tradePairId;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertSlotParameters(
  userId: string,
  slotId: string,
  input: {
    parametersProfile: string;
    hedgeBaseTarget: number;
    riskPerTrade: number;
    maxDailyTrades: number;
    orphanTimeoutMs: number;
  },
) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const slot = await client.query<{ challenge: ChallengeName; phase: "Fase 1" | "Fase 2" | "Funded" }>(
      `select challenge, phase from hedging_slots where id = $1 and user_id = $2`,
      [slotId, userId],
    );
    if (!slot.rowCount) {
      throw new Error("Slot not found");
    }
    const row = slot.rows[0]!;
    const brokerRuntimeState = await client.query<SlotParametersRuntimeRow>(
      `
        select
          hs.challenge,
          hs.phase,
          sp.broker_start_equity::text,
          sr.broker_equity::text,
          broker.metaapi_account_id as broker_metaapi_account_id
        from hedging_slots hs
        left join slot_parameters sp on sp.slot_id = hs.id
        left join slot_runtime sr on sr.slot_id = hs.id
        left join trading_accounts broker
          on broker.slot_id = hs.id and broker.account_type = 'BROKER'
        where hs.id = $1 and hs.user_id = $2
        limit 1
      `,
      [slotId, userId],
    );
    const brokerState = brokerRuntimeState.rows[0]!;
    let brokerStartEquity = Number(
      brokerState.broker_start_equity ?? brokerState.broker_equity ?? 0,
    );

    if (brokerStartEquity <= 0 && brokerState.broker_metaapi_account_id) {
      const brokerMetrics = await getMetaApiAccountLiveMetrics(
        brokerState.broker_metaapi_account_id,
      ).catch(() => null);
      brokerStartEquity = Number(brokerMetrics?.equity ?? brokerMetrics?.balance ?? 0);
    }

    if (brokerStartEquity <= 0) {
      throw new Error(
        "Balance broker iniziale non disponibile. Collega prima il conto broker nella sezione Conti.",
      );
    }
    const currentTarget = getEffectiveCycleTarget({
      challenge: row.challenge,
      phase: row.phase,
      phase1BaseTarget: input.hedgeBaseTarget,
    });
    const currentMultiplier = getEffectiveMultiplier({
      challenge: row.challenge,
      phase: row.phase,
      phase1BaseTarget: input.hedgeBaseTarget,
    });

    await client.query(
      `
        insert into slot_parameters (
          slot_id, parameters_profile, phase1_base_target, broker_start_equity,
          risk_per_trade, max_daily_trades, orphan_timeout_ms
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (slot_id)
        do update set
          parameters_profile = excluded.parameters_profile,
          phase1_base_target = excluded.phase1_base_target,
          broker_start_equity = excluded.broker_start_equity,
          risk_per_trade = excluded.risk_per_trade,
          max_daily_trades = excluded.max_daily_trades,
          orphan_timeout_ms = excluded.orphan_timeout_ms,
          updated_at = now()
      `,
      [
        slotId,
        input.parametersProfile,
        input.hedgeBaseTarget,
        brokerStartEquity,
        input.riskPerTrade,
        input.maxDailyTrades,
        input.orphanTimeoutMs,
      ],
    );

    await client.query(
      `
        update slot_runtime
        set current_target = $2,
            current_multiplier = $3,
            broker_equity = $4,
            updated_at = now()
        where slot_id = $1
      `,
      [slotId, currentTarget, currentMultiplier, brokerStartEquity],
    );

    await client.query("commit");
    const snapshot = await getSlotById(userId, slotId);
    await publishRuntimeEvent({
      event: "slot.runtime.updated",
      userId,
      slotId,
      payload: {
        slotId,
        projection: buildCycleProjection({
          challenge: snapshot.challenge,
          phase1BaseTarget: snapshot.hedgeBaseTarget,
          brokerStartingEquity: snapshot.brokerStartEquity,
        }),
      },
      emittedAt: new Date().toISOString(),
    });
    return snapshot;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function activateSlot(userId: string, slotId: string, phase: "Fase 1" | "Fase 2" | "Funded") {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const slot = await getSlotById(userId, slotId);
    if (!slot.propConnected || !slot.brokerConnected || !slot.parametersProfile) {
      throw new Error("Slot prerequisites not complete");
    }

    await client.query(
      `
        update hedging_slots
        set phase = $3,
            runtime_status = 'RUNNING',
            cycle_state = $4,
            updated_at = now()
        where id = $1 and user_id = $2
      `,
      [
        slotId,
        userId,
        phase,
        phase === "Fase 1"
          ? "FASE_1_ACTIVE"
          : phase === "Fase 2"
            ? "FASE_2_ACTIVE"
            : "FUNDED_ACTIVE",
      ],
    );
    await client.query("commit");
    const snapshot = await getSlotById(userId, slotId);
    await publishRuntimeEvent({
      event: "slot.updated",
      userId,
      slotId,
      payload: snapshot,
      emittedAt: new Date().toISOString(),
    });
    return snapshot;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function pauseSlot(userId: string, slotId: string, billingPause = false) {
  const client = await pool.connect();
  try {
    const nextRuntimeStatus = billingPause ? "PAUSED_BILLING" : "PAUSED_MANUAL";
    const nextCycleState = billingPause ? "PAUSED_BILLING" : "FASE_1_ACTIVE";
    await client.query(
      `
        update hedging_slots
        set runtime_status = $3,
            cycle_state = $4,
            updated_at = now()
        where id = $1 and user_id = $2
      `,
      [slotId, userId, nextRuntimeStatus, nextCycleState],
    );

    const snapshot = await getSlotById(userId, slotId);
    await publishRuntimeEvent({
      event: billingPause ? "billing.paused" : "slot.updated",
      userId,
      slotId,
      payload: snapshot,
      emittedAt: new Date().toISOString(),
    });
    return snapshot;
  } finally {
    client.release();
  }
}

export async function listTradesForSlot(userId: string, slotId: string) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `
        select id, slot_id, symbol, direction, phase, status,
               prop_ticket_id, broker_ticket_id,
               prop_lot_size, broker_lot_final,
               prop_realized_pnl, broker_realized_pnl,
               prop_unrealized_pnl, broker_unrealized_pnl,
               open_time, close_time
        from trade_pairs
        where user_id = $1 and slot_id = $2
        order by created_at desc
      `,
      [userId, slotId],
    );

    return result.rows;
  } finally {
    client.release();
  }
}

export async function getPerformance(userId: string) {
  const client = await pool.connect();
  try {
    const result = await client.query<{
      id: string;
      slot_id: string;
      outcome: string;
      broker_realized_profit: string;
      prop_cost: string;
      net_profit: string;
      funded_gross_payout: string | null;
      closed_at: string;
      slot_name: string;
    }>(
      `
        select cl.*, hs.slot_name
        from cycle_logs cl
        join hedging_slots hs on hs.id = cl.slot_id
        where cl.user_id = $1
        order by cl.closed_at desc
      `,
      [userId],
    );

    return result.rows.map((row) => ({
      id: row.id,
      slot: row.slot_name,
      outcome: row.outcome,
      brokerRealizedProfit: Number(row.broker_realized_profit),
      propCost: Number(row.prop_cost),
      netProfit: Number(row.net_profit),
      fundedGrossPayout: row.funded_gross_payout
        ? Number(row.funded_gross_payout)
        : null,
      closedAt: row.closed_at,
    }));
  } finally {
    client.release();
  }
}

export async function pauseUserSlotsForBilling(userId: string) {
  const client = await pool.connect();
  try {
    const slots = await querySlotsByUser(client, userId);
    for (const slot of slots) {
      await pauseSlot(userId, slot.id, true);
    }
  } finally {
    client.release();
  }
}
