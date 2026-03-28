import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto-service.js";

type Queryable = Pick<PoolClient, "query">;

export type ProxyProtocol = "http" | "https" | "socks5";
export type ProxyStatus = "AVAILABLE" | "IN_USE" | "DISABLED";

type ProxyPoolRow = {
  id: string;
  ip_address: string;
  country_code: string;
  provider: string;
  status: ProxyStatus;
  assigned_user_id: string | null;
  proxy_host: string | null;
  proxy_port: number | null;
  proxy_protocol: ProxyProtocol | null;
  proxy_username_ciphertext: string | null;
  proxy_password_ciphertext: string | null;
  sticky_session_key: string | null;
  sticky_session_ttl_minutes: number | null;
  provider_reference: string | null;
  notes: string | null;
  assigned_at: string | null;
  last_verified_at: string | null;
  last_verification_status: string | null;
  last_verification_error: string | null;
  last_seen_public_ip: string | null;
  last_seen_country_code: string | null;
  last_seen_region: string | null;
  created_at: string;
  updated_at: string;
};

type ResolvedProxyCredentials = ProxyPoolSnapshot & {
  username: string | null;
  password: string | null;
  proxyUrl: string | null;
};

export interface AssignedProxy {
  id: string;
  ipAddress: string;
  countryCode: string;
  host: string;
  port: number | null;
  protocol: ProxyProtocol;
  stickySessionKey: string | null;
  stickySessionTtlMinutes: number;
  lastSeenPublicIp: string | null;
  lastVerificationStatus: string | null;
  proxyUrl: string | null;
}

export interface ProxyPoolSnapshot {
  id: string;
  ipAddress: string;
  countryCode: string;
  provider: string;
  status: ProxyStatus;
  assignedUserId: string | null;
  host: string;
  port: number | null;
  protocol: ProxyProtocol;
  hasCredentials: boolean;
  stickySessionKey: string | null;
  stickySessionTtlMinutes: number;
  providerReference: string | null;
  notes: string | null;
  assignedAt: string | null;
  lastVerifiedAt: string | null;
  lastVerificationStatus: string | null;
  lastVerificationError: string | null;
  lastSeenPublicIp: string | null;
  lastSeenCountryCode: string | null;
  lastSeenRegion: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyPoolUpsertInput {
  id?: string;
  ipAddress?: string;
  countryCode: string;
  provider: string;
  host: string;
  port?: number | null;
  protocol?: ProxyProtocol;
  username?: string;
  password?: string;
  stickySessionKey?: string;
  stickySessionTtlMinutes?: number;
  providerReference?: string;
  notes?: string;
  status?: ProxyStatus;
}

function normalizeCountryCode(value: string | null | undefined) {
  const normalized = String(value ?? "")
    .trim()
    .toUpperCase();
  return normalized || null;
}

function resolveProxyHost(row: ProxyPoolRow) {
  return row.proxy_host?.trim() || row.ip_address.trim();
}

function resolveProxyProtocol(row: ProxyPoolRow): ProxyProtocol {
  return row.proxy_protocol ?? "http";
}

function resolveStickySessionTtlMinutes(row: ProxyPoolRow) {
  return Number(row.sticky_session_ttl_minutes ?? 60);
}

function mapProxyPoolRow(row: ProxyPoolRow): ProxyPoolSnapshot {
  return {
    id: row.id,
    ipAddress: row.ip_address,
    countryCode: row.country_code,
    provider: row.provider,
    status: row.status,
    assignedUserId: row.assigned_user_id,
    host: resolveProxyHost(row),
    port: row.proxy_port,
    protocol: resolveProxyProtocol(row),
    hasCredentials: Boolean(
      row.proxy_username_ciphertext?.trim() || row.proxy_password_ciphertext?.trim(),
    ),
    stickySessionKey: row.sticky_session_key,
    stickySessionTtlMinutes: resolveStickySessionTtlMinutes(row),
    providerReference: row.provider_reference,
    notes: row.notes,
    assignedAt: row.assigned_at,
    lastVerifiedAt: row.last_verified_at,
    lastVerificationStatus: row.last_verification_status,
    lastVerificationError: row.last_verification_error,
    lastSeenPublicIp: row.last_seen_public_ip,
    lastSeenCountryCode: row.last_seen_country_code,
    lastSeenRegion: row.last_seen_region,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toResolvedProxyCredentials(row: ProxyPoolRow): ResolvedProxyCredentials {
  const snapshot = mapProxyPoolRow(row);
  const username = row.proxy_username_ciphertext
    ? decryptSecret(row.proxy_username_ciphertext)
    : null;
  const password = row.proxy_password_ciphertext
    ? decryptSecret(row.proxy_password_ciphertext)
    : null;

  return {
    ...snapshot,
    username,
    password,
    proxyUrl: buildProxyConnectionUrl({
      protocol: snapshot.protocol,
      host: snapshot.host,
      port: snapshot.port,
      username,
      password,
    }),
  };
}

export function buildProxyConnectionUrl(input: {
  protocol: ProxyProtocol;
  host: string;
  port: number | null;
  username?: string | null;
  password?: string | null;
}) {
  const host = input.host.trim();
  if (!host) return null;

  const auth =
    input.username && input.password
      ? `${encodeURIComponent(input.username)}:${encodeURIComponent(input.password)}@`
      : input.username
        ? `${encodeURIComponent(input.username)}@`
        : "";
  const port = input.port ? `:${input.port}` : "";

  return `${input.protocol}://${auth}${host}${port}`;
}

function proxyPoolSelect(alias = "proxy_pool") {
  return `
    select
      ${alias}.id as id,
      ${alias}.ip_address as ip_address,
      ${alias}.country_code as country_code,
      ${alias}.provider as provider,
      ${alias}.status as status,
      ${alias}.assigned_user_id as assigned_user_id,
      ${alias}.proxy_host as proxy_host,
      ${alias}.proxy_port as proxy_port,
      ${alias}.proxy_protocol as proxy_protocol,
      ${alias}.proxy_username_ciphertext as proxy_username_ciphertext,
      ${alias}.proxy_password_ciphertext as proxy_password_ciphertext,
      ${alias}.sticky_session_key as sticky_session_key,
      ${alias}.sticky_session_ttl_minutes as sticky_session_ttl_minutes,
      ${alias}.provider_reference as provider_reference,
      ${alias}.notes as notes,
      ${alias}.assigned_at::text as assigned_at,
      ${alias}.last_verified_at::text as last_verified_at,
      ${alias}.last_verification_status as last_verification_status,
      ${alias}.last_verification_error as last_verification_error,
      ${alias}.last_seen_public_ip as last_seen_public_ip,
      ${alias}.last_seen_country_code as last_seen_country_code,
      ${alias}.last_seen_region as last_seen_region,
      ${alias}.created_at::text as created_at,
      ${alias}.updated_at::text as updated_at
  `;
}

const proxyPoolReturningColumns = `
  id,
  ip_address,
  country_code,
  provider,
  status,
  assigned_user_id,
  proxy_host,
  proxy_port,
  proxy_protocol,
  proxy_username_ciphertext,
  proxy_password_ciphertext,
  sticky_session_key,
  sticky_session_ttl_minutes,
  provider_reference,
  notes,
  assigned_at::text,
  last_verified_at::text,
  last_verification_status,
  last_verification_error,
  last_seen_public_ip,
  last_seen_country_code,
  last_seen_region,
  created_at::text,
  updated_at::text
`;

export async function getProxyInventoryEntryById(
  proxyId: string,
  queryable: Queryable = pool,
) {
  const result = await queryable.query<ProxyPoolRow>(
    `
      ${proxyPoolSelect("proxy_pool")}
      from proxy_pool
      where id = $1
      limit 1
    `,
    [proxyId],
  );

  return result.rows[0] ? toResolvedProxyCredentials(result.rows[0]) : null;
}

export async function getAssignedProxyForUser(
  userId: string,
  queryable: Queryable = pool,
) {
  const result = await queryable.query<ProxyPoolRow>(
    `
      ${proxyPoolSelect("p")}
      from user_profiles up
      join proxy_pool p on p.id = up.proxy_id
      where up.user_id = $1
      limit 1
    `,
    [userId],
  );

  if (!result.rows[0]) {
    return null;
  }

  const resolved = toResolvedProxyCredentials(result.rows[0]);
  return {
    id: resolved.id,
    ipAddress: resolved.ipAddress,
    countryCode: resolved.countryCode,
    host: resolved.host,
    port: resolved.port,
    protocol: resolved.protocol,
    stickySessionKey: resolved.stickySessionKey,
    stickySessionTtlMinutes: resolved.stickySessionTtlMinutes,
    lastSeenPublicIp: resolved.lastSeenPublicIp,
    lastVerificationStatus: resolved.lastVerificationStatus,
    proxyUrl: resolved.proxyUrl,
  } satisfies AssignedProxy;
}

export async function listProxyInventory(queryable: Queryable = pool) {
  const result = await queryable.query<ProxyPoolRow>(
    `
      ${proxyPoolSelect("proxy_pool")}
      from proxy_pool
      order by upper(country_code) asc, provider asc, created_at asc
    `,
  );

  return result.rows.map(mapProxyPoolRow);
}

export async function upsertProxyInventoryEntry(
  input: ProxyPoolUpsertInput,
  queryable: Queryable = pool,
) {
  const host = input.host.trim();
  if (!host) {
    throw new Error("Proxy host is required");
  }

  const countryCode = normalizeCountryCode(input.countryCode);
  if (!countryCode) {
    throw new Error("Proxy country code is required");
  }

  const ipAddress = String(input.ipAddress ?? `${host}${input.port ? `:${input.port}` : ""}`)
    .trim();
  if (!ipAddress) {
    throw new Error("Proxy address is required");
  }

  const values = [
    ipAddress,
    countryCode,
    input.provider.trim(),
    input.status ?? "AVAILABLE",
    host,
    input.port ?? null,
    input.protocol ?? "http",
    input.username?.trim() ? encryptSecret(input.username.trim()) : null,
    input.password?.trim() ? encryptSecret(input.password.trim()) : null,
    input.stickySessionKey?.trim() || null,
    input.stickySessionTtlMinutes ?? 60,
    input.providerReference?.trim() || null,
    input.notes?.trim() || null,
  ];

  let targetId = input.id ?? null;

  if (!targetId) {
    const existing = await queryable.query<{ id: string }>(
      `
        select id
        from proxy_pool
        where provider = $1
          and upper(country_code) = upper($2)
          and coalesce(proxy_host, ip_address) = $3
          and coalesce(proxy_port, -1) = coalesce($4, -1)
        limit 1
      `,
      [input.provider.trim(), countryCode, host, input.port ?? null],
    );

    targetId = existing.rows[0]?.id ?? null;
  }

  const result = targetId
    ? await queryable.query<ProxyPoolRow>(
        `
          update proxy_pool
          set
            ip_address = $2,
            country_code = $3,
            provider = $4,
            status = $5,
            proxy_host = $6,
            proxy_port = $7,
            proxy_protocol = $8,
            proxy_username_ciphertext = $9,
            proxy_password_ciphertext = $10,
            sticky_session_key = $11,
            sticky_session_ttl_minutes = $12,
            provider_reference = $13,
            notes = $14,
            updated_at = now()
          where id = $1
          returning ${proxyPoolReturningColumns}
        `,
        [targetId, ...values],
      )
    : await queryable.query<ProxyPoolRow>(
        `
          insert into proxy_pool (
            ip_address,
            country_code,
            provider,
            status,
            proxy_host,
            proxy_port,
            proxy_protocol,
            proxy_username_ciphertext,
            proxy_password_ciphertext,
            sticky_session_key,
            sticky_session_ttl_minutes,
            provider_reference,
            notes
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          returning ${proxyPoolReturningColumns}
        `,
        values,
      );

  if (!result.rows[0]) {
    throw new Error("Unable to upsert proxy inventory entry");
  }

  return mapProxyPoolRow(result.rows[0]);
}

export async function recordProxyVerificationResult(
  params: {
    proxyId: string;
    endpointUrl: string;
    userId?: string | null;
    success: boolean;
    responseStatus?: number | null;
    observedIp?: string | null;
    observedCountryCode?: string | null;
    observedRegion?: string | null;
    errorMessage?: string | null;
    metadata?: Record<string, unknown>;
  },
  queryable: Queryable = pool,
) {
  await queryable.query(
    `
      update proxy_pool
      set
        last_verified_at = now(),
        last_verification_status = $2,
        last_verification_error = $3,
        last_seen_public_ip = $4,
        last_seen_country_code = $5,
        last_seen_region = $6,
        updated_at = now()
      where id = $1
    `,
    [
      params.proxyId,
      params.success ? "VERIFIED" : "FAILED",
      params.errorMessage ?? null,
      params.observedIp ?? null,
      normalizeCountryCode(params.observedCountryCode),
      params.observedRegion ?? null,
    ],
  );

  await queryable.query(
    `
      insert into proxy_verification_runs (
        proxy_id,
        user_id,
        endpoint_url,
        success,
        response_status,
        observed_ip,
        observed_country_code,
        observed_region,
        error_message,
        metadata
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
    `,
    [
      params.proxyId,
      params.userId ?? null,
      params.endpointUrl,
      params.success,
      params.responseStatus ?? null,
      params.observedIp ?? null,
      normalizeCountryCode(params.observedCountryCode),
      params.observedRegion ?? null,
      params.errorMessage ?? null,
      JSON.stringify(params.metadata ?? {}),
    ],
  );
}

export async function assignDedicatedProxyForUser(params: {
  client: PoolClient;
  userId: string;
  billingCountry?: string | null;
}): Promise<AssignedProxy> {
  const normalizedBillingCountry = normalizeCountryCode(params.billingCountry);

  const existing = await params.client.query<ProxyPoolRow>(
    `
      ${proxyPoolSelect("p")}
      from user_profiles up
      join proxy_pool p on p.id = up.proxy_id
      where up.user_id = $1
      limit 1
      for update of p
    `,
    [params.userId],
  );

  if (existing.rowCount) {
    const row = existing.rows[0]!;
    if (row.status !== "DISABLED") {
      await params.client.query(
        `
          update proxy_pool
          set status = 'IN_USE',
              assigned_user_id = $1,
              assigned_at = coalesce(assigned_at, now()),
              updated_at = now()
          where id = $2
        `,
        [params.userId, row.id],
      );

      const resolved = toResolvedProxyCredentials(row);
      return {
        id: resolved.id,
        ipAddress: resolved.ipAddress,
        countryCode: resolved.countryCode,
        host: resolved.host,
        port: resolved.port,
        protocol: resolved.protocol,
        stickySessionKey: resolved.stickySessionKey,
        stickySessionTtlMinutes: resolved.stickySessionTtlMinutes,
        lastSeenPublicIp: resolved.lastSeenPublicIp,
        lastVerificationStatus: resolved.lastVerificationStatus,
        proxyUrl: resolved.proxyUrl,
      };
    }

    await params.client.query(
      `
        update user_profiles
        set proxy_id = null,
            updated_at = now()
        where user_id = $1
      `,
      [params.userId],
    );
  }

  const picked = await params.client.query<ProxyPoolRow>(
    `
      ${proxyPoolSelect("proxy_pool")}
      from proxy_pool
      where status = 'AVAILABLE'
        and assigned_user_id is null
        and (
          $1::text is null
          or upper(country_code) = upper($1)
        )
      order by last_verified_at desc nulls last, created_at asc
      limit 1
      for update skip locked
    `,
    [normalizedBillingCountry],
  );

  let row = picked.rows[0] ?? null;

  if (!row && !config.PROXY_STRICT_COUNTRY_MATCH) {
    const fallback = await params.client.query<ProxyPoolRow>(
      `
        ${proxyPoolSelect("proxy_pool")}
        from proxy_pool
        where status = 'AVAILABLE'
          and assigned_user_id is null
        order by last_verified_at desc nulls last, created_at asc
        limit 1
        for update skip locked
      `,
    );

    row = fallback.rows[0] ?? null;
  }

  if (!row) {
    const countryLabel = normalizedBillingCountry || "the selected user";
    throw new Error(`No residential proxy available for ${countryLabel}`);
  }

  await params.client.query(
    `
      update proxy_pool
      set status = 'IN_USE',
          assigned_user_id = $1,
          assigned_at = now(),
          updated_at = now()
      where id = $2
    `,
    [params.userId, row.id],
  );

  await params.client.query(
    `
      insert into user_profiles (user_id, billing_country, proxy_id, metaapi_region)
      values ($1, $2, $3, $4)
      on conflict (user_id)
      do update
      set billing_country = excluded.billing_country,
          metaapi_region = excluded.metaapi_region,
          proxy_id = excluded.proxy_id,
          updated_at = now()
    `,
    [
      params.userId,
      normalizedBillingCountry ?? normalizeCountryCode(row.country_code),
      row.id,
      config.METAAPI_REGION,
    ],
  );

  const resolved = toResolvedProxyCredentials(row);
  return {
    id: resolved.id,
    ipAddress: resolved.ipAddress,
    countryCode: resolved.countryCode,
    host: resolved.host,
    port: resolved.port,
    protocol: resolved.protocol,
    stickySessionKey: resolved.stickySessionKey,
    stickySessionTtlMinutes: resolved.stickySessionTtlMinutes,
    lastSeenPublicIp: resolved.lastSeenPublicIp,
    lastVerificationStatus: resolved.lastVerificationStatus,
    proxyUrl: resolved.proxyUrl,
  };
}

async function releaseAssignedProxyForUser(
  userId: string,
  queryable: Queryable,
  options?: { preserveUserProfileProxy?: boolean },
) {
  await queryable.query(
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

  if (!options?.preserveUserProfileProxy) {
    await queryable.query(
      `
        update user_profiles
        set proxy_id = null,
            updated_at = now()
        where user_id = $1
      `,
      [userId],
    );
  }
}

export async function assignSpecificProxyToUser(params: {
  proxyId: string;
  userId: string;
  billingCountry?: string | null;
  metaapiRegion?: string | null;
  queryable?: Queryable;
}) {
  const queryable = params.queryable ?? pool;
  const normalizedBillingCountry = normalizeCountryCode(params.billingCountry);

  await releaseAssignedProxyForUser(params.userId, queryable, {
    preserveUserProfileProxy: true,
  });

  const picked = await queryable.query<ProxyPoolRow>(
    `
      ${proxyPoolSelect("proxy_pool")}
      from proxy_pool
      where id = $1
      limit 1
      for update
    `,
    [params.proxyId],
  );

  const row = picked.rows[0];
  if (!row) {
    throw new Error("Selected residential proxy was not found");
  }

  if (row.status === "DISABLED") {
    throw new Error("Selected residential proxy is disabled");
  }

  if (row.assigned_user_id && row.assigned_user_id !== params.userId) {
    throw new Error("Selected residential proxy is already assigned to another user");
  }

  await queryable.query(
    `
      update proxy_pool
      set status = 'IN_USE',
          assigned_user_id = $1,
          assigned_at = now(),
          updated_at = now()
      where id = $2
    `,
    [params.userId, row.id],
  );

  await queryable.query(
    `
      insert into user_profiles (user_id, billing_country, proxy_id, metaapi_region)
      values ($1, $2, $3, $4)
      on conflict (user_id)
      do update
      set billing_country = excluded.billing_country,
          metaapi_region = excluded.metaapi_region,
          proxy_id = excluded.proxy_id,
          updated_at = now()
    `,
    [
      params.userId,
      normalizedBillingCountry ?? normalizeCountryCode(row.country_code),
      row.id,
      params.metaapiRegion ?? config.METAAPI_REGION,
    ],
  );

  const resolved = toResolvedProxyCredentials(row);
  return {
    id: resolved.id,
    ipAddress: resolved.ipAddress,
    countryCode: resolved.countryCode,
    host: resolved.host,
    port: resolved.port,
    protocol: resolved.protocol,
    stickySessionKey: resolved.stickySessionKey,
    stickySessionTtlMinutes: resolved.stickySessionTtlMinutes,
    lastSeenPublicIp: resolved.lastSeenPublicIp,
    lastVerificationStatus: resolved.lastVerificationStatus,
    proxyUrl: resolved.proxyUrl,
  };
}

export async function releaseProxyForUser(userId: string, queryable: Queryable = pool) {
  await releaseAssignedProxyForUser(userId, queryable);
}
