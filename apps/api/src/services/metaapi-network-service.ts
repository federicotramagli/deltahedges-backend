import type { PoolClient } from "pg";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "./crypto-service.js";

type Queryable = PoolClient | typeof pool;

type UserPolicyRow = {
  user_id: string;
  dedicated_ip_required: boolean;
  dedicated_ip_family: string;
  preferred_region: string | null;
  last_quota_status: string | null;
  last_quota_error: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

type AccountAssignmentRow = {
  user_id: string;
  metaapi_account_id: string;
  credential_fingerprint: string;
  account_type: "PROP" | "BROKER";
  platform: "mt4" | "mt5";
  login_ciphertext: string;
  server_ciphertext: string;
  dedicated_ip_requested: boolean;
  dedicated_ip_family: string | null;
  metaapi_region: string | null;
  metaapi_user_id: string | null;
  last_deployment_state: string | null;
  last_connection_status: string | null;
  last_synced_at: string | null;
  deleted_at: string | null;
};

export interface MetaApiDedicatedIpSettings {
  userId: string;
  dedicatedIpRequired: boolean;
  dedicatedIpFamily: "ipv4";
  preferredRegion: string;
}

export interface MetaApiUserNetworkPolicySnapshot {
  userId: string;
  dedicatedIpRequired: boolean;
  dedicatedIpFamily: "ipv4";
  preferredRegion: string;
  lastQuotaStatus: string | null;
  lastQuotaError: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MetaApiAccountNetworkAssignmentSnapshot {
  userId: string;
  metaapiAccountId: string;
  credentialFingerprint: string;
  accountType: "PROP" | "BROKER";
  platform: "mt4" | "mt5";
  loginMasked: string;
  server: string;
  dedicatedIpRequested: boolean;
  dedicatedIpFamily: "ipv4" | null;
  metaapiRegion: string | null;
  metaapiUserId: string | null;
  lastDeploymentState: string | null;
  lastConnectionStatus: string | null;
  lastSyncedAt: string | null;
  deletedAt: string | null;
}

export interface MetaApiUserNetworkSnapshot {
  policy: MetaApiUserNetworkPolicySnapshot;
  assignments: MetaApiAccountNetworkAssignmentSnapshot[];
}

function toPreferredRegion(value: string | null | undefined) {
  return value?.trim() || config.METAAPI_REGION;
}

function normalizeDedicatedIpFamily(value: string | null | undefined): "ipv4" {
  return value === "ipv4" ? "ipv4" : "ipv4";
}

function maskLogin(login: string) {
  if (!login) return "";
  if (login.length <= 4) return login;
  return `${login.slice(0, 2)}•••${login.slice(-2)}`;
}

function mapPolicyRow(row: UserPolicyRow): MetaApiUserNetworkPolicySnapshot {
  return {
    userId: row.user_id,
    dedicatedIpRequired: Boolean(row.dedicated_ip_required),
    dedicatedIpFamily: normalizeDedicatedIpFamily(row.dedicated_ip_family),
    preferredRegion: toPreferredRegion(row.preferred_region),
    lastQuotaStatus: row.last_quota_status,
    lastQuotaError: row.last_quota_error,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAssignmentRow(
  row: AccountAssignmentRow,
): MetaApiAccountNetworkAssignmentSnapshot {
  return {
    userId: row.user_id,
    metaapiAccountId: row.metaapi_account_id,
    credentialFingerprint: row.credential_fingerprint,
    accountType: row.account_type,
    platform: row.platform,
    loginMasked: maskLogin(decryptSecret(row.login_ciphertext)),
    server: decryptSecret(row.server_ciphertext),
    dedicatedIpRequested: Boolean(row.dedicated_ip_requested),
    dedicatedIpFamily: row.dedicated_ip_family
      ? normalizeDedicatedIpFamily(row.dedicated_ip_family)
      : null,
    metaapiRegion: row.metaapi_region,
    metaapiUserId: row.metaapi_user_id,
    lastDeploymentState: row.last_deployment_state,
    lastConnectionStatus: row.last_connection_status,
    lastSyncedAt: row.last_synced_at,
    deletedAt: row.deleted_at,
  };
}

async function ensurePolicyRow(
  queryable: Queryable,
  userId: string,
): Promise<UserPolicyRow> {
  const result = await queryable.query<UserPolicyRow>(
    `
      insert into metaapi_user_network_policies (
        user_id,
        dedicated_ip_required,
        dedicated_ip_family,
        preferred_region,
        created_at,
        updated_at
      )
      values ($1, $2, 'ipv4', $3, now(), now())
      on conflict (user_id)
      do update set
        updated_at = metaapi_user_network_policies.updated_at
      returning
        user_id,
        dedicated_ip_required,
        dedicated_ip_family,
        preferred_region,
        last_quota_status,
        last_quota_error,
        last_synced_at::text,
        created_at::text,
        updated_at::text
    `,
    [userId, config.METAAPI_ALLOCATE_DEDICATED_IP, config.METAAPI_REGION],
  );

  return result.rows[0]!;
}

export async function resolveMetaApiDedicatedIpSettingsForUser(
  userId: string,
  queryable: Queryable = pool,
): Promise<MetaApiDedicatedIpSettings> {
  const row = await ensurePolicyRow(queryable, userId);

  return {
    userId,
    dedicatedIpRequired: Boolean(row.dedicated_ip_required),
    dedicatedIpFamily: normalizeDedicatedIpFamily(row.dedicated_ip_family),
    preferredRegion: toPreferredRegion(row.preferred_region),
  };
}

export async function upsertMetaApiUserNetworkPolicy(params: {
  userId: string;
  dedicatedIpRequired: boolean;
  dedicatedIpFamily?: "ipv4";
  preferredRegion?: string | null;
  queryable?: Queryable;
}) {
  const queryable = params.queryable ?? pool;
  const result = await queryable.query<UserPolicyRow>(
    `
      insert into metaapi_user_network_policies (
        user_id,
        dedicated_ip_required,
        dedicated_ip_family,
        preferred_region,
        created_at,
        updated_at
      )
      values ($1, $2, $3, $4, now(), now())
      on conflict (user_id)
      do update set
        dedicated_ip_required = excluded.dedicated_ip_required,
        dedicated_ip_family = excluded.dedicated_ip_family,
        preferred_region = excluded.preferred_region,
        updated_at = now()
      returning
        user_id,
        dedicated_ip_required,
        dedicated_ip_family,
        preferred_region,
        last_quota_status,
        last_quota_error,
        last_synced_at::text,
        created_at::text,
        updated_at::text
    `,
    [
      params.userId,
      params.dedicatedIpRequired,
      params.dedicatedIpFamily ?? "ipv4",
      params.preferredRegion?.trim() || config.METAAPI_REGION,
    ],
  );

  return mapPolicyRow(result.rows[0]!);
}

export async function recordMetaApiAccountNetworkAssignment(params: {
  userId: string;
  metaapiAccountId: string;
  credentialFingerprint: string;
  accountType: "PROP" | "BROKER";
  platform: "mt4" | "mt5";
  login: string;
  server: string;
  dedicatedIpRequested: boolean;
  dedicatedIpFamily?: "ipv4" | null;
  metaapiRegion?: string | null;
  metaapiUserId?: string | null;
  deploymentState?: string | null;
  connectionStatus?: string | null;
  queryable?: Queryable;
}) {
  const queryable = params.queryable ?? pool;
  await queryable.query(
    `
      insert into metaapi_account_network_assignments (
        user_id,
        metaapi_account_id,
        credential_fingerprint,
        account_type,
        platform,
        login_ciphertext,
        server_ciphertext,
        dedicated_ip_requested,
        dedicated_ip_family,
        metaapi_region,
        metaapi_user_id,
        last_deployment_state,
        last_connection_status,
        last_synced_at,
        deleted_at,
        created_at,
        updated_at
      )
      values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now(), null, now(), now()
      )
      on conflict (metaapi_account_id)
      do update set
        user_id = excluded.user_id,
        credential_fingerprint = excluded.credential_fingerprint,
        account_type = excluded.account_type,
        platform = excluded.platform,
        login_ciphertext = excluded.login_ciphertext,
        server_ciphertext = excluded.server_ciphertext,
        dedicated_ip_requested = excluded.dedicated_ip_requested,
        dedicated_ip_family = excluded.dedicated_ip_family,
        metaapi_region = excluded.metaapi_region,
        metaapi_user_id = excluded.metaapi_user_id,
        last_deployment_state = excluded.last_deployment_state,
        last_connection_status = excluded.last_connection_status,
        last_synced_at = now(),
        deleted_at = null,
        updated_at = now()
    `,
    [
      params.userId,
      params.metaapiAccountId,
      params.credentialFingerprint,
      params.accountType,
      params.platform,
      encryptSecret(params.login),
      encryptSecret(params.server),
      params.dedicatedIpRequested,
      params.dedicatedIpFamily ?? null,
      params.metaapiRegion ?? null,
      params.metaapiUserId ?? null,
      params.deploymentState ?? null,
      params.connectionStatus ?? null,
    ],
  );
}

export async function updateMetaApiAccountNetworkSnapshot(
  metaapiAccountId: string,
  values: {
    dedicatedIpRequested?: boolean;
    dedicatedIpFamily?: "ipv4" | null;
    metaapiRegion?: string | null;
    metaapiUserId?: string | null;
    deploymentState?: string | null;
    connectionStatus?: string | null;
  },
  queryable: Queryable = pool,
) {
  await queryable.query(
    `
      update metaapi_account_network_assignments
      set dedicated_ip_requested = coalesce($2, dedicated_ip_requested),
          dedicated_ip_family = coalesce($3, dedicated_ip_family),
          metaapi_region = coalesce($4, metaapi_region),
          metaapi_user_id = coalesce($5, metaapi_user_id),
          last_deployment_state = coalesce($6, last_deployment_state),
          last_connection_status = coalesce($7, last_connection_status),
          last_synced_at = now(),
          updated_at = now()
      where metaapi_account_id = $1
    `,
    [
      metaapiAccountId,
      values.dedicatedIpRequested ?? null,
      values.dedicatedIpFamily ?? null,
      values.metaapiRegion ?? null,
      values.metaapiUserId ?? null,
      values.deploymentState ?? null,
      values.connectionStatus ?? null,
    ],
  );
}

export async function markMetaApiAccountNetworkAssignmentDeleted(
  metaapiAccountId: string,
  queryable: Queryable = pool,
) {
  await queryable.query(
    `
      update metaapi_account_network_assignments
      set deleted_at = coalesce(deleted_at, now()),
          last_synced_at = now(),
          updated_at = now()
      where metaapi_account_id = $1
    `,
    [metaapiAccountId],
  );
}

export async function getMetaApiUserNetworkSnapshot(
  userId: string,
  queryable: Queryable = pool,
): Promise<MetaApiUserNetworkSnapshot> {
  const policyRow = await ensurePolicyRow(queryable, userId);
  const assignmentsResult = await queryable.query<AccountAssignmentRow>(
    `
      select
        user_id,
        metaapi_account_id,
        credential_fingerprint,
        account_type,
        platform,
        login_ciphertext,
        server_ciphertext,
        dedicated_ip_requested,
        dedicated_ip_family,
        metaapi_region,
        metaapi_user_id,
        last_deployment_state,
        last_connection_status,
        last_synced_at::text,
        deleted_at::text
      from metaapi_account_network_assignments
      where user_id = $1
      order by updated_at desc, created_at desc
    `,
    [userId],
  );

  return {
    policy: mapPolicyRow(policyRow),
    assignments: assignmentsResult.rows.map(mapAssignmentRow),
  };
}
