alter table if exists metaapi_account_registry
  add column if not exists owner_user_id uuid references auth.users(id) on delete cascade,
  add column if not exists dedicated_ip_required boolean not null default false,
  add column if not exists dedicated_ip_family text not null default 'ipv4',
  add column if not exists metaapi_region text;

alter table if exists metaapi_account_registry
  drop constraint if exists metaapi_account_registry_credential_fingerprint_key;

drop index if exists metaapi_account_registry_fingerprint_idx;

create unique index if not exists metaapi_account_registry_owner_fingerprint_idx
  on metaapi_account_registry(owner_user_id, credential_fingerprint);

create table if not exists metaapi_user_network_policies (
  user_id uuid primary key references auth.users(id) on delete cascade,
  dedicated_ip_required boolean not null default false,
  dedicated_ip_family text not null default 'ipv4',
  preferred_region text,
  last_quota_status text,
  last_quota_error text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists metaapi_account_network_assignments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  metaapi_account_id text not null unique,
  credential_fingerprint text not null,
  account_type account_type not null,
  platform text not null default 'mt5',
  login_ciphertext text not null,
  server_ciphertext text not null,
  dedicated_ip_requested boolean not null default false,
  dedicated_ip_family text,
  metaapi_region text,
  metaapi_user_id text,
  last_deployment_state text,
  last_connection_status text,
  last_synced_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists metaapi_account_network_assignments_user_id_idx
  on metaapi_account_network_assignments(user_id, updated_at desc);
