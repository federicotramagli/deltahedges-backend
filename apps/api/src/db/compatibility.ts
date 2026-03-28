import { pool } from "./pool.js";
import { logger } from "../logger.js";

export async function ensureDatabaseCompatibility() {
  try {
    await pool.query("create extension if not exists pgcrypto");

    await pool.query(`
      do $$
      begin
        if exists (select 1 from pg_type where typname = 'cycle_outcome') then
          if not exists (
            select 1
            from pg_enum
            where enumtypid = 'cycle_outcome'::regtype
              and enumlabel = 'PASS_FASE_1'
          ) then
            alter type cycle_outcome add value 'PASS_FASE_1';
          end if;

          if not exists (
            select 1
            from pg_enum
            where enumtypid = 'cycle_outcome'::regtype
              and enumlabel = 'PASS_FASE_2'
          ) then
            alter type cycle_outcome add value 'PASS_FASE_2';
          end if;
        end if;
      end
      $$;
    `);

    await pool.query(`
      alter table if exists trading_accounts
        add column if not exists platform text not null default 'mt5'
    `);

    await pool.query(`
      create table if not exists saved_accounts (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references auth.users(id) on delete cascade,
        label text not null,
        account_type account_type not null,
        platform text not null default 'mt5',
        account_name text,
        login_ciphertext text not null,
        password_ciphertext text not null,
        server_ciphertext text not null,
        broker_lot_step numeric(12,4) not null default 0.01,
        metaapi_account_id text,
        connection_state text not null default 'pending',
        validation_message text,
        connection_status text,
        balance numeric(12,2),
        equity numeric(12,2),
        last_validated_at timestamptz,
        deleted_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);

    await pool.query(`
      alter table if exists saved_accounts
        add column if not exists metaapi_account_id text,
        add column if not exists connection_state text not null default 'pending',
        add column if not exists validation_message text,
        add column if not exists connection_status text,
        add column if not exists balance numeric(12,2),
        add column if not exists equity numeric(12,2),
        add column if not exists last_validated_at timestamptz,
        add column if not exists deleted_at timestamptz
    `);

    await pool.query(`
      create table if not exists metaapi_account_registry (
        id uuid primary key default gen_random_uuid(),
        credential_fingerprint text not null,
        platform text not null default 'mt5',
        login_ciphertext text not null,
        server_ciphertext text not null,
        password_fingerprint text,
        metaapi_account_id text,
        last_connection_status text,
        last_deployment_state text,
        last_validated_at timestamptz,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);

    await pool.query(`
      alter table if exists metaapi_account_registry
        add column if not exists platform text not null default 'mt5',
        add column if not exists owner_user_id uuid references auth.users(id) on delete cascade,
        add column if not exists login_ciphertext text,
        add column if not exists server_ciphertext text,
        add column if not exists password_fingerprint text,
        add column if not exists metaapi_account_id text,
        add column if not exists dedicated_ip_required boolean not null default false,
        add column if not exists dedicated_ip_family text not null default 'ipv4',
        add column if not exists metaapi_region text,
        add column if not exists last_connection_status text,
        add column if not exists last_deployment_state text,
        add column if not exists last_validated_at timestamptz
    `);

    await pool.query(`
      alter table if exists metaapi_account_registry
        drop constraint if exists metaapi_account_registry_credential_fingerprint_key
    `);

    await pool.query(`
      drop index if exists metaapi_account_registry_fingerprint_idx
    `);

    await pool.query(`
      create unique index if not exists metaapi_account_registry_owner_fingerprint_idx
        on metaapi_account_registry(owner_user_id, credential_fingerprint)
    `);

    await pool.query(`
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
      )
    `);

    await pool.query(`
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
      )
    `);

    await pool.query(`
      create index if not exists metaapi_account_network_assignments_user_id_idx
        on metaapi_account_network_assignments(user_id, updated_at desc)
    `);

    await pool.query(`
      create unique index if not exists saved_accounts_user_label_type_idx
        on saved_accounts(user_id, label, account_type)
    `);

    await pool.query(`
      alter table if exists hedging_slots
        alter column seat_id drop not null
    `);

    await pool.query(`
      alter table if exists proxy_pool
        add column if not exists proxy_host text,
        add column if not exists proxy_port integer,
        add column if not exists proxy_protocol text default 'http',
        add column if not exists proxy_username_ciphertext text,
        add column if not exists proxy_password_ciphertext text,
        add column if not exists sticky_session_key text,
        add column if not exists sticky_session_ttl_minutes integer not null default 60,
        add column if not exists provider_reference text,
        add column if not exists notes text,
        add column if not exists assigned_at timestamptz,
        add column if not exists last_verified_at timestamptz,
        add column if not exists last_verification_status text,
        add column if not exists last_verification_error text,
        add column if not exists last_seen_public_ip text,
        add column if not exists last_seen_country_code text,
        add column if not exists last_seen_region text
    `);

    await pool.query(`
      update proxy_pool
      set proxy_host = coalesce(nullif(proxy_host, ''), ip_address),
          proxy_protocol = coalesce(nullif(proxy_protocol, ''), 'http'),
          sticky_session_ttl_minutes = coalesce(sticky_session_ttl_minutes, 60)
      where proxy_host is null
         or proxy_protocol is null
         or sticky_session_ttl_minutes is null
    `);

    await pool.query(`
      create table if not exists proxy_verification_runs (
        id uuid primary key default gen_random_uuid(),
        proxy_id uuid not null references proxy_pool(id) on delete cascade,
        user_id uuid references auth.users(id) on delete set null,
        endpoint_url text not null,
        success boolean not null,
        response_status integer,
        observed_ip text,
        observed_country_code text,
        observed_region text,
        error_message text,
        metadata jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      )
    `);

    await pool.query(`
      create index if not exists proxy_verification_runs_proxy_id_idx
        on proxy_verification_runs(proxy_id, created_at desc)
    `);
  } catch (error) {
    logger.warn({ error }, "Database compatibility bootstrap skipped");
  }
}
