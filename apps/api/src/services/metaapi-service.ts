import crypto from "node:crypto";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { logger } from "../logger.js";
import { encryptSecret } from "./crypto-service.js";
import {
  markMetaApiAccountNetworkAssignmentDeleted,
  recordMetaApiAccountNetworkAssignment,
  resolveMetaApiDedicatedIpSettingsForUser,
  updateMetaApiAccountNetworkSnapshot,
  type MetaApiDedicatedIpSettings,
} from "./metaapi-network-service.js";

const METAAPI_PROVISIONING_BASE_URL =
  "https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai";

type MetaApiDeploymentState =
  | "CREATED"
  | "DEPLOYING"
  | "DEPLOYED"
  | "DEPLOY_FAILED"
  | "UNDEPLOYING"
  | "UNDEPLOYED"
  | "DELETING"
  | "DELETE_FAILED"
  | "REDEPLOY_FAILED";

type MetaApiConnectionStatus =
  | "CONNECTED"
  | "DISCONNECTED"
  | "DISCONNECTED_FROM_BROKER"
  | "ACCOUNT_FAILED"
  | "BROKER_CONNECTION_FAILED"
  | "UNSTABLE"
  | "UNKNOWN";

interface MetaApiAccountDto {
  _id?: string;
  id?: string;
  login?: string;
  name?: string;
  server?: string;
  version?: number;
  createdAt?: string;
  state?: MetaApiDeploymentState;
  connectionStatus?: MetaApiConnectionStatus;
  region?: string;
  userId?: string;
  allocateDedicatedIp?: string | null;
}

type MetaApiRegistryRow = {
  owner_user_id: string | null;
  credential_fingerprint: string;
  platform: "mt4" | "mt5";
  login_ciphertext: string;
  server_ciphertext: string;
  password_fingerprint: string | null;
  metaapi_account_id: string | null;
  dedicated_ip_required: boolean;
  dedicated_ip_family: string | null;
  metaapi_region: string | null;
  last_connection_status: string | null;
  last_deployment_state: string | null;
  last_validated_at: string | null;
};

export interface MetaApiAccountConnectionSnapshot {
  accountId: string;
  deploymentState: MetaApiDeploymentState | "UNKNOWN";
  connectionStatus: MetaApiConnectionStatus;
  region: string | null;
}

interface MetaApiAccountInformationDto {
  balance?: number | string;
  equity?: number | string;
}

interface MetaApiPositionDto {
  id?: string | number;
  type?: string;
  symbol?: string;
  time?: string;
  updateTime?: string;
  openPrice?: number | string;
}

export interface MetaApiOpenPositionSnapshot {
  id: string;
  symbol: string;
  type: "POSITION_TYPE_BUY" | "POSITION_TYPE_SELL" | null;
  time: string | null;
  updateTime: string | null;
  openPrice: number | null;
}

interface MetaApiSymbolPriceDto {
  symbol?: string;
  bid?: number | string;
  ask?: number | string;
  profitTickValue?: number | string;
  lossTickValue?: number | string;
}

interface MetaApiSymbolSpecificationDto {
  symbol?: string;
  tickSize?: number | string;
}

export interface MetaApiSymbolPriceSnapshot {
  symbol: string;
  bid: number;
  ask: number;
  profitTickValue: number;
  lossTickValue: number;
}

export interface MetaApiSymbolSpecificationSnapshot {
  symbol: string;
  tickSize: number;
}

export interface MetaApiAccountLiveMetricsSnapshot
  extends MetaApiAccountConnectionSnapshot {
  balance: number | null;
  equity: number | null;
  unrealizedPnl: number | null;
}

type CachedLiveMetricsEntry = {
  snapshot: MetaApiAccountLiveMetricsSnapshot;
  expiresAt: number;
  staleUntil: number;
};

type MetaApiErrorPayload =
  | string
  | {
      error?: string;
      message?: string;
      details?: unknown;
      [key: string]: unknown;
    };

export interface ProvisionMetaApiAccountInput {
  userId: string;
  slotId: string;
  accountType: "PROP" | "BROKER";
  platform?: "mt4" | "mt5";
  login: string;
  password: string;
  server: string;
  proxyIp?: string;
  existingAccountId?: string | null;
}

export interface ProvisionMetaApiAccountResult {
  accountId: string;
  deploymentState: "DEPLOYED" | "DEPLOYING" | "DEPLOY_FAILED" | "NOT_DEPLOYED";
  connectionStatus: string;
}

export interface SubmitMetaApiTradeInput {
  accountId: string;
  symbol: string;
  direction: "BUY" | "SELL";
  volume: number;
  stopLoss?: number | null;
  stopLossUnits?: "RELATIVE_CURRENCY" | null;
  takeProfit?: number | null;
  takeProfitUnits?: "RELATIVE_CURRENCY" | null;
  comment?: string;
  retries?: number;
  delayMs?: number;
}

export interface SubmitMetaApiTradeResult {
  orderId?: string;
  numericCode?: number;
  stringCode?: string;
  message?: string;
}

export interface CloseMetaApiPositionsResult {
  matchedPositions: number;
  closedPositions: number;
}

export interface UpdateMetaApiPositionProtectionInput {
  accountId: string;
  positionId: string;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

function createTransactionId() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeMetaApiIdentity(input: ProvisionMetaApiAccountInput) {
  return {
    platform: (input.platform ?? config.METAAPI_DEFAULT_PLATFORM) as "mt4" | "mt5",
    login: String(input.login ?? "").trim(),
    password: String(input.password ?? "").trim(),
    server: String(input.server ?? "").trim(),
  };
}

function buildMetaApiCredentialFingerprint(input: ProvisionMetaApiAccountInput) {
  const normalized = normalizeMetaApiIdentity(input);
  return crypto
    .createHash("sha256")
    .update(
      `${normalized.platform.toLowerCase()}|${normalized.login.toLowerCase()}|${normalized.server.toLowerCase()}`,
    )
    .digest("hex");
}

function buildMetaApiPasswordFingerprint(input: ProvisionMetaApiAccountInput) {
  const normalized = normalizeMetaApiIdentity(input);
  return crypto
    .createHash("sha256")
    .update(normalized.password)
    .digest("hex");
}

function buildMetaApiAccountName(input: ProvisionMetaApiAccountInput) {
  const normalized = normalizeMetaApiIdentity(input);
  const loginPart = normalized.login.replace(/[^a-z0-9]/gi, "").slice(0, 12) || "account";
  const serverPart = crypto
    .createHash("sha1")
    .update(normalized.server.toLowerCase())
    .digest("hex")
    .slice(0, 8);
  const userPart = crypto
    .createHash("sha1")
    .update(input.userId)
    .digest("hex")
    .slice(0, 8);
  return `DeltaHedge ${normalized.platform.toUpperCase()} ${loginPart} ${serverPart} u${userPart}`;
}

function createMagicNumber(input: ProvisionMetaApiAccountInput) {
  const normalized = normalizeMetaApiIdentity(input);
  const base = crypto
    .createHash("sha1")
    .update(
      `${input.userId}:${normalized.platform.toLowerCase()}:${normalized.login.toLowerCase()}:${normalized.server.toLowerCase()}`,
    )
    .digest()
    .readUInt32BE(0);
  return (base % 900000) + 100000;
}

function mapDeploymentState(
  state: MetaApiDeploymentState | undefined,
): ProvisionMetaApiAccountResult["deploymentState"] {
  switch (state) {
    case "DEPLOYED":
      return "DEPLOYED";
    case "DEPLOYING":
      return "DEPLOYING";
    case "DEPLOY_FAILED":
    case "REDEPLOY_FAILED":
      return "DEPLOY_FAILED";
    default:
      return "NOT_DEPLOYED";
  }
}

function getRetryDelayMs(retryAfterHeader: string | null, attempt: number) {
  if (!retryAfterHeader) return Math.min(1000 * (attempt + 1), 5000);

  const asNumber = Number(retryAfterHeader);
  if (Number.isFinite(asNumber)) {
    return Math.max(1000, asNumber * 1000);
  }

  const parsedDate = Date.parse(retryAfterHeader);
  if (!Number.isNaN(parsedDate)) {
    return Math.max(1000, parsedDate - Date.now());
  }

  return Math.min(1000 * (attempt + 1), 5000);
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function toNullableNumber(value: number | string | undefined | null) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isMetaApiAccountNotReadyTradeError(message: string) {
  return /not connected to broker yet|request url you use does not match the account region/i.test(
    message,
  );
}

function isMetaApiRateLimitError(message: string) {
  return /cpu credits per 6h|rate limit|overloading our servers|extend your quota|retry your request/i.test(
    message,
  );
}

function formatMetaApiDetails(details: unknown) {
  if (!details) return "";

  if (Array.isArray(details)) {
    return details
      .map((detail) => {
        if (typeof detail === "string") return detail;
        if (!detail || typeof detail !== "object") return JSON.stringify(detail);

        const record = detail as Record<string, unknown>;
        const field =
          typeof record.path === "string"
            ? record.path
            : typeof record.parameter === "string"
              ? record.parameter
              : typeof record.field === "string"
                ? record.field
                : "";
        const message =
          typeof record.message === "string"
            ? record.message
            : typeof record.description === "string"
              ? record.description
              : JSON.stringify(record);

        return field ? `${field}: ${message}` : message;
      })
      .filter(Boolean)
      .join("; ");
  }

  if (typeof details === "string") return details;

  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function buildMetaApiErrorMessage(
  payload: MetaApiErrorPayload,
  fallback: string,
) {
  if (typeof payload === "string") {
    return payload;
  }

  const base =
    typeof payload.message === "string" && payload.message.trim().length > 0
      ? payload.message.trim()
      : typeof payload.error === "string" && payload.error.trim().length > 0
        ? payload.error.trim()
        : fallback;
  const details = formatMetaApiDetails(payload.details);

  return details ? `${base}: ${details}` : base;
}

function isMetaApiNotFoundError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /not found/i.test(message);
}

function isMetaApiConnectionFailureStatus(status: string | null | undefined) {
  return (
    status === "ACCOUNT_FAILED" ||
    status === "BROKER_CONNECTION_FAILED" ||
    status === "DISCONNECTED_FROM_BROKER"
  );
}

function toNullableMoney(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Number(numeric.toFixed(2));
}

const LIVE_METRICS_CACHE_TTL_MS = 20_000;
const LIVE_METRICS_EMPTY_TTL_MS = 5_000;
const LIVE_METRICS_STALE_GRACE_MS = 120_000;
const liveMetricsCache = new Map<string, CachedLiveMetricsEntry>();
const liveMetricsInflight = new Map<string, Promise<MetaApiAccountLiveMetricsSnapshot>>();

function cloneLiveMetricsSnapshot(
  snapshot: MetaApiAccountLiveMetricsSnapshot,
): MetaApiAccountLiveMetricsSnapshot {
  return { ...snapshot };
}

function rememberLiveMetrics(
  accountId: string,
  snapshot: MetaApiAccountLiveMetricsSnapshot,
  ttlMs: number,
) {
  const now = Date.now();
  liveMetricsCache.set(accountId, {
    snapshot: cloneLiveMetricsSnapshot(snapshot),
    expiresAt: now + ttlMs,
    staleUntil: now + LIVE_METRICS_STALE_GRACE_MS,
  });

  return snapshot;
}

function getCachedLiveMetrics(
  accountId: string,
  options?: { includeStale?: boolean },
): MetaApiAccountLiveMetricsSnapshot | null {
  const cached = liveMetricsCache.get(accountId);
  if (!cached) return null;

  const now = Date.now();
  if (cached.expiresAt > now) {
    return cloneLiveMetricsSnapshot(cached.snapshot);
  }

  if (options?.includeStale && cached.staleUntil > now) {
    return cloneLiveMetricsSnapshot(cached.snapshot);
  }

  if (cached.staleUntil <= now) {
    liveMetricsCache.delete(accountId);
  }

  return null;
}

async function readMetaApiRegistryRow(
  input: ProvisionMetaApiAccountInput,
): Promise<MetaApiRegistryRow | null> {
  const result = await pool.query<MetaApiRegistryRow>(
    `
      select
        owner_user_id,
        credential_fingerprint,
        platform,
        login_ciphertext,
        server_ciphertext,
        password_fingerprint,
        metaapi_account_id,
        dedicated_ip_required,
        dedicated_ip_family,
        metaapi_region,
        last_connection_status,
        last_deployment_state,
        last_validated_at::text
      from metaapi_account_registry
      where owner_user_id = $1
        and credential_fingerprint = $2
      limit 1
    `,
    [input.userId, buildMetaApiCredentialFingerprint(input)],
  );

  return result.rows[0] ?? null;
}

async function upsertMetaApiRegistryRow(
  input: ProvisionMetaApiAccountInput,
  values: {
    metaApiAccountId: string | null;
    dedicatedIpRequired: boolean;
    dedicatedIpFamily: "ipv4";
    metaApiRegion: string;
    connectionStatus?: string | null;
    deploymentState?: string | null;
  },
) {
  const normalized = normalizeMetaApiIdentity(input);
  await pool.query(
    `
      insert into metaapi_account_registry (
        owner_user_id,
        credential_fingerprint,
        platform,
        login_ciphertext,
        server_ciphertext,
        password_fingerprint,
        metaapi_account_id,
        dedicated_ip_required,
        dedicated_ip_family,
        metaapi_region,
        last_connection_status,
        last_deployment_state,
        last_validated_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), now())
      on conflict (owner_user_id, credential_fingerprint)
      do update set
        owner_user_id = excluded.owner_user_id,
        platform = excluded.platform,
        login_ciphertext = excluded.login_ciphertext,
        server_ciphertext = excluded.server_ciphertext,
        password_fingerprint = excluded.password_fingerprint,
        metaapi_account_id = excluded.metaapi_account_id,
        dedicated_ip_required = excluded.dedicated_ip_required,
        dedicated_ip_family = excluded.dedicated_ip_family,
        metaapi_region = excluded.metaapi_region,
        last_connection_status = excluded.last_connection_status,
        last_deployment_state = excluded.last_deployment_state,
        last_validated_at = now(),
        updated_at = now()
    `,
    [
      input.userId,
      buildMetaApiCredentialFingerprint(input),
      normalized.platform,
      encryptSecret(normalized.login),
      encryptSecret(normalized.server),
      buildMetaApiPasswordFingerprint(input),
      values.metaApiAccountId,
      values.dedicatedIpRequired,
      values.dedicatedIpFamily,
      values.metaApiRegion,
      values.connectionStatus ?? null,
      values.deploymentState ?? null,
    ],
  );
}

function shouldUpdateMetaApiCredentials(
  registryRow: MetaApiRegistryRow | null,
  input: ProvisionMetaApiAccountInput,
) {
  if (!registryRow) return false;
  return registryRow.password_fingerprint !== buildMetaApiPasswordFingerprint(input);
}

function shouldRedeployMetaApiAccount(snapshot: MetaApiAccountConnectionSnapshot) {
  return (
    snapshot.deploymentState === "UNKNOWN" ||
    snapshot.deploymentState === "CREATED" ||
    snapshot.deploymentState === "UNDEPLOYED" ||
    snapshot.deploymentState === "DELETE_FAILED" ||
    snapshot.deploymentState === "DEPLOY_FAILED" ||
    snapshot.deploymentState === "REDEPLOY_FAILED"
  );
}

function shouldRepairMetaApiAccountWithoutRegistry(
  snapshot: MetaApiAccountConnectionSnapshot,
) {
  return (
    isMetaApiConnectionFailureStatus(snapshot.connectionStatus) ||
    shouldRedeployMetaApiAccount(snapshot)
  );
}

function buildMetaApiCreateAccountPayload(
  input: ProvisionMetaApiAccountInput,
  networkSettings: MetaApiDedicatedIpSettings,
) {
  const payload: Record<string, unknown> = {
    name: buildMetaApiAccountName(input),
    server: input.server,
    password: input.password,
    magic: createMagicNumber(input),
    region: networkSettings.preferredRegion,
    type: "cloud-g2",
  };

  if (networkSettings.dedicatedIpRequired) {
    payload.allocateDedicatedIp = networkSettings.dedicatedIpFamily;
  }

  return payload;
}

function buildMetaApiUpdateAccountPayload(
  input: ProvisionMetaApiAccountInput,
  networkSettings: MetaApiDedicatedIpSettings,
) {
  const payload: Record<string, unknown> = {
    name: buildMetaApiAccountName(input),
    server: input.server,
    password: input.password,
    magic: createMagicNumber(input),
  };

  if (networkSettings.dedicatedIpRequired) {
    payload.allocateDedicatedIp = networkSettings.dedicatedIpFamily;
  }

  return payload;
}

async function requestMetaApi<T>(
  path: string,
  init: RequestInit & { transactionId?: string },
  options: { allowAcceptedRetry?: boolean; acceptedRetries?: number } = {},
): Promise<T | null> {
  const headers = new Headers(init.headers);
  headers.set("auth-token", config.METAAPI_ACCESS_TOKEN ?? "");

  if (init.transactionId) {
    headers.set("transaction-id", init.transactionId);
  }

  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(`${METAAPI_PROVISIONING_BASE_URL}${path}`, {
    ...init,
    headers,
  });

  if (response.status === 202 && options.allowAcceptedRetry) {
    const acceptedRetries = options.acceptedRetries ?? 8;
    if (acceptedRetries <= 0) {
      throw new Error(`MetaApi request still pending after retries for ${path}`);
    }

    await sleep(getRetryDelayMs(response.headers.get("retry-after"), acceptedRetries));
    return requestMetaApi<T>(path, init, {
      ...options,
      acceptedRetries: acceptedRetries - 1,
    });
  }

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as T & MetaApiErrorPayload)
    : ((await response.text()) as unknown as T & MetaApiErrorPayload);

  if (!response.ok) {
    const message = buildMetaApiErrorMessage(
      payload as MetaApiErrorPayload,
      `MetaApi request failed (${response.status})`,
    );

    logger.error(
      {
        path,
        status: response.status,
        payload,
      },
      "MetaApi request failed",
    );

    throw new Error(message);
  }

  return payload;
}

async function readMetaApiAccount(accountId: string, retries = 6): Promise<MetaApiAccountDto> {
  try {
    const account = await requestMetaApi<MetaApiAccountDto>(
      `/users/current/accounts/${accountId}`,
      { method: "GET" },
    );
    if (!account) {
      throw new Error(`MetaApi account ${accountId} returned empty payload`);
    }

    await updateMetaApiAccountNetworkSnapshot(accountId, {
      dedicatedIpRequested: account.allocateDedicatedIp === "ipv4",
      dedicatedIpFamily: account.allocateDedicatedIp === "ipv4" ? "ipv4" : null,
      metaapiRegion: account.region ?? null,
      metaapiUserId: account.userId ?? null,
      deploymentState: account.state ?? null,
      connectionStatus: account.connectionStatus ?? null,
    }).catch(() => null);

    return account;
  } catch (error) {
    if (retries <= 0) {
      throw error;
    }
    await sleep(1000);
    return readMetaApiAccount(accountId, retries - 1);
  }
}

async function listMetaApiAccounts(): Promise<MetaApiAccountDto[]> {
  const accounts = await requestMetaApi<MetaApiAccountDto[]>(
    "/users/current/accounts",
    { method: "GET" },
  );
  return Array.isArray(accounts) ? accounts : [];
}

async function deleteMetaApiAccount(accountId: string) {
  await requestMetaApi(`/users/current/accounts/${accountId}`, {
    method: "DELETE",
  });
}

async function clearMetaApiRegistryAccountId(accountId: string) {
  await pool.query(
    `
      update metaapi_account_registry
      set metaapi_account_id = null,
          last_validated_at = now(),
          updated_at = now()
      where metaapi_account_id = $1
    `,
    [accountId],
  );
}

async function findReusableMetaApiAccount(
  input: ProvisionMetaApiAccountInput,
): Promise<MetaApiAccountDto | null> {
  const accounts = await listMetaApiAccounts();
  const expectedVersion = input.platform === "mt4" ? 4 : 5;
  const stableName = buildMetaApiAccountName(input);

  const matches = accounts.filter((account) => {
    const accountId = account._id ?? account.id;
    if (!accountId) return false;

    return (
      String(account.name ?? "") === stableName &&
      String(account.login ?? "") === String(input.login) &&
      String(account.server ?? "") === String(input.server) &&
      Number(account.version ?? 0) === expectedVersion
    );
  });

  if (matches.length === 0) {
    return null;
  }

  matches.sort((left, right) => {
    const leftStable = String(left.name ?? "") === stableName ? 1 : 0;
    const rightStable = String(right.name ?? "") === stableName ? 1 : 0;
    if (leftStable !== rightStable) {
      return rightStable - leftStable;
    }

    const leftConnected = left.connectionStatus === "CONNECTED" ? 1 : 0;
    const rightConnected = right.connectionStatus === "CONNECTED" ? 1 : 0;
    if (leftConnected !== rightConnected) {
      return rightConnected - leftConnected;
    }

    const leftDeployed = left.state === "DEPLOYED" ? 1 : 0;
    const rightDeployed = right.state === "DEPLOYED" ? 1 : 0;
    if (leftDeployed !== rightDeployed) {
      return rightDeployed - leftDeployed;
    }

    const leftCreatedAt = Date.parse(left.createdAt ?? "") || 0;
    const rightCreatedAt = Date.parse(right.createdAt ?? "") || 0;
    return rightCreatedAt - leftCreatedAt;
  });

  return matches[0] ?? null;
}

async function cleanupDuplicateMetaApiAccounts(
  input: ProvisionMetaApiAccountInput,
  keepAccountId: string,
) {
  const accounts = await listMetaApiAccounts();
  const expectedVersion = input.platform === "mt4" ? 4 : 5;
  const stableName = buildMetaApiAccountName(input);

  const duplicates = accounts.filter((account) => {
    const accountId = account._id ?? account.id;
    if (!accountId || accountId === keepAccountId) return false;

    return (
      String(account.name ?? "") === stableName &&
      String(account.login ?? "") === String(input.login) &&
      String(account.server ?? "") === String(input.server) &&
      Number(account.version ?? 0) === expectedVersion
    );
  });

  for (const duplicate of duplicates) {
    const duplicateId = duplicate._id ?? duplicate.id;
    if (!duplicateId) continue;

    try {
      await deleteMetaApiAccount(duplicateId);
      logger.info(
        {
          keepAccountId,
          deletedAccountId: duplicateId,
          accountType: input.accountType,
          login: input.login,
          server: input.server,
        },
        "Deleted duplicate MetaApi account",
      );
    } catch (error) {
      logger.warn(
        {
          keepAccountId,
          deletedAccountId: duplicateId,
          accountType: input.accountType,
          error,
        },
        "Unable to delete duplicate MetaApi account",
      );
    }
  }
}

export async function ensureSingleMetaApiAccount(
  input: ProvisionMetaApiAccountInput,
  keepAccountId: string,
) {
  await cleanupDuplicateMetaApiAccounts(input, keepAccountId);
}

type MetaApiClientRequestOptions = {
  retries?: number;
  delayMs?: number;
};

async function requestMetaApiClient<T>(
  accountId: string,
  path: string,
  init: RequestInit,
  options: MetaApiClientRequestOptions = {},
): Promise<T | null> {
  const retries = options.retries ?? 0;
  const delayMs = options.delayMs ?? 1500;
  const account = await readMetaApiAccount(accountId, 1);
  const clientRegion = account.region ?? config.METAAPI_REGION;
  const response = await fetch(
    `https://mt-client-api-v1.${clientRegion}.agiliumtrade.ai${path}`,
    {
      ...init,
      headers: {
        "auth-token": config.METAAPI_ACCESS_TOKEN ?? "",
        "content-type": "application/json",
        ...(init.headers || {}),
      },
    },
  );

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? ((await response.json()) as T & MetaApiErrorPayload)
    : ((await response.text()) as unknown as T & MetaApiErrorPayload);

  if (!response.ok) {
    const message = buildMetaApiErrorMessage(
      payload as MetaApiErrorPayload,
      `MetaApi client request failed (${response.status})`,
    );

    if (retries > 0 && isMetaApiAccountNotReadyTradeError(message)) {
      logger.warn(
        {
          accountId,
          path,
          status: response.status,
          region: clientRegion,
          retriesLeft: retries,
          message,
        },
        "MetaApi client request not ready yet, retrying",
      );

      await sleep(delayMs);
      return requestMetaApiClient<T>(accountId, path, init, {
        retries: retries - 1,
        delayMs,
      });
    }

    logger.error(
      {
        accountId,
        path,
        status: response.status,
        payload,
        region: clientRegion,
      },
      "MetaApi client request failed",
    );

    throw new Error(message);
  }

  return payload;
}

export async function getMetaApiAccountConnectionSnapshot(
  accountId: string,
): Promise<MetaApiAccountConnectionSnapshot> {
  const account = await readMetaApiAccount(accountId, 1);
  return {
    accountId,
    deploymentState: account.state ?? "UNKNOWN",
    connectionStatus: account.connectionStatus ?? "UNKNOWN",
    region: account.region ?? null,
  };
}

export async function getMetaApiAccountLiveMetrics(
  accountId: string,
): Promise<MetaApiAccountLiveMetricsSnapshot> {
  const cached = getCachedLiveMetrics(accountId);
  if (cached) {
    return cached;
  }

  const inflight = liveMetricsInflight.get(accountId);
  if (inflight) {
    return inflight;
  }

  const task = (async () => {
    const snapshot = await getMetaApiAccountConnectionSnapshot(accountId);

    if (snapshot.connectionStatus !== "CONNECTED") {
      return rememberLiveMetrics(
        accountId,
        {
          ...snapshot,
          balance: null,
          equity: null,
          unrealizedPnl: null,
        },
        LIVE_METRICS_EMPTY_TTL_MS,
      );
    }

    try {
      const accountInformation = await requestMetaApiClient<MetaApiAccountInformationDto>(
        accountId,
        `/users/current/accounts/${accountId}/account-information`,
        { method: "GET" },
        { retries: 4, delayMs: 1500 },
      );

      const balance = toNullableMoney(accountInformation?.balance);
      const equity = toNullableMoney(accountInformation?.equity);

      return rememberLiveMetrics(
        accountId,
        {
          ...snapshot,
          balance,
          equity,
          unrealizedPnl:
            balance !== null && equity !== null
              ? toNullableMoney(equity - balance)
              : null,
        },
        LIVE_METRICS_CACHE_TTL_MS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isMetaApiRateLimitError(message)) {
        const stale = getCachedLiveMetrics(accountId, { includeStale: true });
        if (stale) {
          logger.warn(
            { accountId, message },
            "MetaApi live metrics rate limited, serving stale cached metrics",
          );
          return stale;
        }

        logger.warn(
          { accountId, message },
          "MetaApi live metrics rate limited before cache warmup, serving connection snapshot only",
        );

        return rememberLiveMetrics(
          accountId,
          {
            ...snapshot,
            balance: null,
            equity: null,
            unrealizedPnl: null,
          },
          LIVE_METRICS_EMPTY_TTL_MS,
        );
      }

      throw error;
    }
  })().finally(() => {
    liveMetricsInflight.delete(accountId);
  });

  liveMetricsInflight.set(accountId, task);
  return task;
}

async function listMetaApiPositions(accountId: string): Promise<MetaApiPositionDto[]> {
  const positions = await requestMetaApiClient<MetaApiPositionDto[]>(
    accountId,
    `/users/current/accounts/${accountId}/positions`,
    { method: "GET" },
    { retries: 20, delayMs: 2000 },
  );

  return Array.isArray(positions) ? positions : [];
}

export async function getMetaApiOpenPositions(
  accountId: string,
  options?: { symbol?: string | null },
): Promise<MetaApiOpenPositionSnapshot[]> {
  const positions = await listMetaApiPositions(accountId);
  const normalizedSymbol = options?.symbol?.trim().toUpperCase() || null;

  return positions
    .map((position) => ({
      id:
        position.id === undefined || position.id === null ? "" : String(position.id),
      symbol: String(position.symbol ?? "").trim().toUpperCase(),
      type: (() => {
        if (position.type === "POSITION_TYPE_BUY") return "POSITION_TYPE_BUY" as const;
        if (position.type === "POSITION_TYPE_SELL") return "POSITION_TYPE_SELL" as const;
        return null;
      })(),
      time: position.time ?? null,
      updateTime: position.updateTime ?? null,
      openPrice: toNullableNumber(position.openPrice),
    }))
    .filter((position) => position.id && position.symbol)
    .filter((position) => {
      if (!normalizedSymbol) return true;
      return position.symbol === normalizedSymbol;
    });
}

async function closeMetaApiPositionById(
  accountId: string,
  positionId: string,
): Promise<SubmitMetaApiTradeResult | null> {
  return requestMetaApiClient<SubmitMetaApiTradeResult>(
    accountId,
    `/users/current/accounts/${accountId}/trade`,
    {
      method: "POST",
      body: JSON.stringify({
        actionType: "POSITION_CLOSE_ID",
        positionId,
      }),
    },
  );
}

export async function closeMetaApiPositions(
  accountId: string,
  options?: { symbol?: string | null },
): Promise<CloseMetaApiPositionsResult> {
  const positions = await listMetaApiPositions(accountId);
  const normalizedSymbol = options?.symbol?.trim().toUpperCase() || null;
  const matchingPositions = positions.filter((position) => {
    if (!normalizedSymbol) return true;
    return String(position.symbol ?? "").trim().toUpperCase() === normalizedSymbol;
  });

  let closedPositions = 0;
  for (const position of matchingPositions) {
    const positionId = position.id === undefined || position.id === null ? null : String(position.id);
    if (!positionId) {
      continue;
    }

    await closeMetaApiPositionById(accountId, positionId);
    closedPositions += 1;
  }

  return {
    matchedPositions: matchingPositions.length,
    closedPositions,
  };
}

export async function getMetaApiSymbolPrice(
  accountId: string,
  symbol: string,
): Promise<MetaApiSymbolPriceSnapshot> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const payload = await requestMetaApiClient<MetaApiSymbolPriceDto>(
    accountId,
    `/users/current/accounts/${accountId}/symbols/${normalizedSymbol}/current-price?keepSubscription=true`,
    { method: "GET" },
    { retries: 20, delayMs: 1500 },
  );

  const bid = toNullableNumber(payload?.bid);
  const ask = toNullableNumber(payload?.ask);
  const profitTickValue = toNullableNumber(payload?.profitTickValue);
  const lossTickValue = toNullableNumber(payload?.lossTickValue);

  if (
    bid === null ||
    ask === null ||
    profitTickValue === null ||
    lossTickValue === null
  ) {
    throw new Error(
      `MetaApi symbol price for ${normalizedSymbol} is missing required quote fields`,
    );
  }

  return {
    symbol: normalizedSymbol,
    bid,
    ask,
    profitTickValue,
    lossTickValue,
  };
}

export async function getMetaApiSymbolSpecification(
  accountId: string,
  symbol: string,
): Promise<MetaApiSymbolSpecificationSnapshot> {
  const normalizedSymbol = symbol.trim().toUpperCase();
  const payload = await requestMetaApiClient<MetaApiSymbolSpecificationDto>(
    accountId,
    `/users/current/accounts/${accountId}/symbols/${normalizedSymbol}/specification`,
    { method: "GET" },
    { retries: 20, delayMs: 1500 },
  );
  const tickSize = toNullableNumber(payload?.tickSize);

  if (tickSize === null || tickSize <= 0) {
    throw new Error(
      `MetaApi symbol specification for ${normalizedSymbol} is missing a valid tickSize`,
    );
  }

  return {
    symbol: normalizedSymbol,
    tickSize,
  };
}

export async function waitForMetaApiPosition(
  accountId: string,
  options: {
    symbol?: string | null;
    direction?: "BUY" | "SELL" | null;
    excludePositionIds?: string[];
    retries?: number;
    delayMs?: number;
  } = {},
): Promise<MetaApiOpenPositionSnapshot> {
  const retries = options.retries ?? 20;
  const delayMs = options.delayMs ?? 500;
  const normalizedSymbol = options.symbol?.trim().toUpperCase() || null;
  const normalizedDirection =
    options.direction === "BUY"
      ? "POSITION_TYPE_BUY"
      : options.direction === "SELL"
        ? "POSITION_TYPE_SELL"
        : null;
  const excludedIds = new Set(options.excludePositionIds ?? []);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const positions = await getMetaApiOpenPositions(accountId, {
      symbol: normalizedSymbol,
    });
    const matchingPosition = positions
      .filter((position) => !excludedIds.has(position.id))
      .filter((position) => {
        if (!normalizedDirection) return true;
        return position.type === normalizedDirection;
      })
      .sort((left, right) => {
        const leftTime = Date.parse(left.updateTime ?? left.time ?? "") || 0;
        const rightTime = Date.parse(right.updateTime ?? right.time ?? "") || 0;
        return rightTime - leftTime;
      })[0];

    if (matchingPosition) {
      return matchingPosition;
    }

    if (attempt === retries) {
      throw new Error(
        `MetaApi position for ${normalizedSymbol ?? "symbol"} was not visible after trade execution`,
      );
    }

    await sleep(delayMs);
  }

  throw new Error("MetaApi position did not become visible after trade execution");
}

export async function updateMetaApiPositionProtection(
  input: UpdateMetaApiPositionProtectionInput,
): Promise<SubmitMetaApiTradeResult> {
  return requestMetaApiClient<SubmitMetaApiTradeResult>(
    input.accountId,
    `/users/current/accounts/${input.accountId}/trade`,
    {
      method: "POST",
      body: JSON.stringify({
        actionType: "POSITION_MODIFY",
        positionId: input.positionId,
        ...(input.stopLoss !== undefined && input.stopLoss !== null
          ? {
              stopLoss: Number(input.stopLoss.toFixed(2)),
              stopLossUnits: "ABSOLUTE_PRICE",
            }
          : {}),
        ...(input.takeProfit !== undefined && input.takeProfit !== null
          ? {
              takeProfit: Number(input.takeProfit.toFixed(2)),
              takeProfitUnits: "ABSOLUTE_PRICE",
            }
          : {}),
      }),
    },
  ).then((payload) => payload ?? {});
}

export async function waitUntilMetaApiAccountConnected(
  accountId: string,
  options: { retries?: number; delayMs?: number } = {},
) {
  const retries = options.retries ?? 60;
  const delayMs = options.delayMs ?? 2000;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const account = await readMetaApiAccount(accountId, 1);
    if (account.connectionStatus === "CONNECTED") {
      return account;
    }

    if (attempt === retries) {
      throw new Error(
        `MetaApi account ${accountId} not connected yet (status: ${account.connectionStatus ?? "UNKNOWN"}). Check platform/login/password/server.`,
      );
    }

    await sleep(delayMs);
  }

  throw new Error(`MetaApi account ${accountId} did not reach CONNECTED state`);
}

export async function waitUntilMetaApiAccountReady(
  accountId: string,
  options: { retries?: number; delayMs?: number } = {},
) {
  const retries = options.retries ?? 90;
  const delayMs = options.delayMs ?? 2000;
  let lastStatus: string | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const snapshot = await getMetaApiAccountConnectionSnapshot(accountId);
    lastStatus = snapshot.connectionStatus;

    if (snapshot.connectionStatus === "CONNECTED") {
      try {
        await requestMetaApiClient<MetaApiAccountInformationDto>(
          accountId,
          `/users/current/accounts/${accountId}/account-information`,
          { method: "GET" },
          { retries: 2, delayMs: 1500 },
        );

        return await readMetaApiAccount(accountId, 1);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (!isMetaApiAccountNotReadyTradeError(message)) {
          throw error;
        }
      }
    }

    if (isMetaApiConnectionFailureStatus(snapshot.connectionStatus)) {
      throw new Error(
        `MetaApi account ${accountId} entered failure state (${snapshot.connectionStatus}). Check credentials and server.`,
      );
    }

    if (attempt === retries) {
      throw new Error(
        `MetaApi account ${accountId} did not become client-ready in time (last status: ${lastStatus ?? "UNKNOWN"}).`,
      );
    }

    await sleep(delayMs);
  }

  throw new Error(`MetaApi account ${accountId} did not become client-ready`);
}

export async function destroyMetaApiAccount(accountId: string) {
  try {
    await deleteMetaApiAccount(accountId);
  } catch (error) {
    if (!isMetaApiNotFoundError(error)) {
      throw error;
    }
  } finally {
    await clearMetaApiRegistryAccountId(accountId).catch(() => null);
    await markMetaApiAccountNetworkAssignmentDeleted(accountId).catch(() => null);
  }
}

async function deployMetaApiAccount(accountId: string) {
  await requestMetaApi(
    `/users/current/accounts/${accountId}/deploy`,
    { method: "POST" },
  );
}

async function configureMetaApiTradingAccount(
  accountId: string,
  credentials: Pick<ProvisionMetaApiAccountInput, "login" | "password">,
) {
  await requestMetaApi(
    `/users/current/accounts/${accountId}/credentials`,
    {
      method: "PUT",
      body: JSON.stringify({
        login: credentials.login,
        password: credentials.password,
      }),
    },
  );
}

async function updateMetaApiAccount(
  accountId: string,
  input: ProvisionMetaApiAccountInput,
  networkSettings: MetaApiDedicatedIpSettings,
) {
  await requestMetaApi(
    `/users/current/accounts/${accountId}`,
    {
      method: "PUT",
      body: JSON.stringify(buildMetaApiUpdateAccountPayload(input, networkSettings)),
    },
  );
  await deployMetaApiAccount(accountId);
}

async function createMetaApiAccount(
  input: ProvisionMetaApiAccountInput,
  networkSettings: MetaApiDedicatedIpSettings,
) {
  const transactionId = createTransactionId();

  const created = await requestMetaApi<MetaApiAccountDto & { id?: string; _id?: string }>(
    "/users/current/accounts",
    {
      method: "POST",
      transactionId,
      body: JSON.stringify({
        login: input.login,
        platform: input.platform ?? config.METAAPI_DEFAULT_PLATFORM,
        ...buildMetaApiCreateAccountPayload(input, networkSettings),
      }),
    },
    { allowAcceptedRetry: true },
  );

  const accountId = created?._id ?? created?.id;
  if (!accountId) {
    throw new Error("MetaApi create account did not return an account id");
  }

  return accountId;
}

export async function provisionMetaApiAccount(
  input: ProvisionMetaApiAccountInput,
): Promise<ProvisionMetaApiAccountResult> {
  if (!config.METAAPI_ACCESS_TOKEN) {
    return {
      accountId: `mock_${input.accountType.toLowerCase()}_${crypto
        .createHash("sha1")
        .update(`${input.slotId}:${input.login}:${input.server}`)
        .digest("hex")
        .slice(0, 18)}`,
      deploymentState: "DEPLOYED",
      connectionStatus: "CONNECTED",
    };
  }

  const networkSettings = await resolveMetaApiDedicatedIpSettingsForUser(input.userId);
  const registryRow = await readMetaApiRegistryRow(input);
  let accountId =
    input.existingAccountId ??
    registryRow?.metaapi_account_id ??
    null;

  const reuseExistingAccount = async (candidateAccountId: string) => {
    const currentAccount = await readMetaApiAccount(candidateAccountId);
    const expectedStableName = buildMetaApiAccountName(input);
    const snapshot: MetaApiAccountConnectionSnapshot = {
      accountId: candidateAccountId,
      deploymentState: currentAccount.state ?? "UNKNOWN",
      connectionStatus: currentAccount.connectionStatus ?? "UNKNOWN",
      region: currentAccount.region ?? null,
    };
    const shouldUpdateCredentials =
      shouldUpdateMetaApiCredentials(registryRow, input) ||
      (!registryRow && shouldRepairMetaApiAccountWithoutRegistry(snapshot));
    const dedicatedIpMismatch =
      networkSettings.dedicatedIpRequired && currentAccount.allocateDedicatedIp !== "ipv4";
    const identityMismatch = String(currentAccount.name ?? "") !== expectedStableName;
    const regionMismatch =
      Boolean(networkSettings.preferredRegion) &&
      String(currentAccount.region ?? "") !== networkSettings.preferredRegion;

    if (shouldUpdateCredentials || dedicatedIpMismatch || identityMismatch || regionMismatch) {
      await updateMetaApiAccount(candidateAccountId, input, networkSettings);
      return readMetaApiAccount(candidateAccountId);
    }

    if (shouldRedeployMetaApiAccount(snapshot)) {
      await deployMetaApiAccount(candidateAccountId);
      return readMetaApiAccount(candidateAccountId);
    }

    return currentAccount;
  };

  if (accountId) {
    try {
      await reuseExistingAccount(accountId);
    } catch (error) {
      if (!isMetaApiNotFoundError(error)) {
        throw error;
      }

      logger.warn(
        {
          slotId: input.slotId,
          accountType: input.accountType,
          accountId,
        },
        "MetaApi referenced account not found, searching reusable account",
      );

      accountId = null;
    }
  }

  if (!accountId) {
    const reusableAccount = await findReusableMetaApiAccount(input);
    const reusableAccountId = reusableAccount?._id ?? reusableAccount?.id ?? null;

    if (reusableAccountId) {
      accountId = reusableAccountId;
      try {
        await reuseExistingAccount(accountId);
      } catch (error) {
        if (!isMetaApiNotFoundError(error)) {
          throw error;
        }

        logger.warn(
          {
            slotId: input.slotId,
            accountType: input.accountType,
            accountId,
          },
          "MetaApi reusable account disappeared, creating a new one",
        );

        accountId = null;
      }
    }
  }

  if (!accountId) {
    accountId = await createMetaApiAccount(input, networkSettings);
    await deployMetaApiAccount(accountId);
  }

  const account = await readMetaApiAccount(accountId);
  const deploymentState = mapDeploymentState(account.state);
  const connectionStatus = account.connectionStatus ?? "UNKNOWN";

  logger.info(
    {
      slotId: input.slotId,
      accountType: input.accountType,
      platform: input.platform ?? config.METAAPI_DEFAULT_PLATFORM,
      accountId,
      deploymentState,
      connectionStatus,
      server: input.server,
    },
    "MetaApi account provisioned",
  );

  await upsertMetaApiRegistryRow(input, {
    metaApiAccountId: accountId,
    dedicatedIpRequired: networkSettings.dedicatedIpRequired,
    dedicatedIpFamily: networkSettings.dedicatedIpFamily,
    metaApiRegion: networkSettings.preferredRegion,
    connectionStatus,
    deploymentState,
  });

  await recordMetaApiAccountNetworkAssignment({
    userId: input.userId,
    metaapiAccountId: accountId,
    credentialFingerprint: buildMetaApiCredentialFingerprint(input),
    accountType: input.accountType,
    platform: (input.platform ?? config.METAAPI_DEFAULT_PLATFORM) as "mt4" | "mt5",
    login: input.login,
    server: input.server,
    dedicatedIpRequested:
      account.allocateDedicatedIp === "ipv4" || networkSettings.dedicatedIpRequired,
    dedicatedIpFamily:
      account.allocateDedicatedIp === "ipv4" || networkSettings.dedicatedIpRequired
        ? "ipv4"
        : null,
    metaapiRegion: account.region ?? networkSettings.preferredRegion,
    metaapiUserId: account.userId ?? null,
    deploymentState,
    connectionStatus,
  });

  await cleanupDuplicateMetaApiAccounts(input, accountId);

  return {
    accountId,
    deploymentState,
    connectionStatus,
  };
}

export async function submitMetaApiTrade(
  input: SubmitMetaApiTradeInput,
): Promise<SubmitMetaApiTradeResult> {
  if (!config.METAAPI_ACCESS_TOKEN) {
    return {
      orderId: `mock_order_${crypto.randomBytes(6).toString("hex")}`,
      numericCode: 10009,
      stringCode: "TRADE_RETCODE_DONE",
      message: "Mock trade executed",
    };
  }

  const retries = input.retries ?? 20;
  const delayMs = input.delayMs ?? 3000;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const account = await readMetaApiAccount(input.accountId, 1);
    const clientRegion = account.region ?? config.METAAPI_REGION;
    const clientBaseUrl = `https://mt-client-api-v1.${clientRegion}.agiliumtrade.ai`;
    const requestBody: Record<string, unknown> = {
      actionType: input.direction === "BUY" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL",
      symbol: input.symbol,
      volume: Number(input.volume.toFixed(2)),
    };

    if (input.stopLoss !== undefined && input.stopLoss !== null) {
      requestBody.stopLoss = Number(input.stopLoss.toFixed(2));
      requestBody.stopLossUnits = input.stopLossUnits ?? "RELATIVE_CURRENCY";
    }

    if (input.takeProfit !== undefined && input.takeProfit !== null) {
      requestBody.takeProfit = Number(input.takeProfit.toFixed(2));
      requestBody.takeProfitUnits = input.takeProfitUnits ?? "RELATIVE_CURRENCY";
    }

    if (input.comment && input.comment.trim().length > 0) {
      requestBody.comment = input.comment.trim();
    }

    const response = await fetch(
      `${clientBaseUrl}/users/current/accounts/${input.accountId}/trade`,
      {
        method: "POST",
        headers: {
          "auth-token": config.METAAPI_ACCESS_TOKEN,
          "content-type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );

    const payload = (await response.json()) as SubmitMetaApiTradeResult &
      MetaApiErrorPayload;

    if (response.ok) {
      return payload;
    }

    const message = buildMetaApiErrorMessage(
      payload,
      `MetaApi trade failed (${response.status})`,
    );

    if (attempt < retries && isMetaApiAccountNotReadyTradeError(message)) {
      logger.warn(
        {
          accountId: input.accountId,
          attempt: attempt + 1,
          retries,
          region: clientRegion,
          connectionStatus: account.connectionStatus,
          state: account.state,
          message,
        },
        "MetaApi trade delayed while waiting for stable connection",
      );
      await sleep(delayMs);
      continue;
    }

    logger.error(
      {
        accountId: input.accountId,
        status: response.status,
        payload,
        region: clientRegion,
      },
      "MetaApi trade failed",
    );

    throw new Error(message);
  }

  throw new Error(`MetaApi trade failed after retries for account ${input.accountId}`);
}
