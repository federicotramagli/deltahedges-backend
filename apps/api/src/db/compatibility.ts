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
        credential_fingerprint text not null unique,
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
        add column if not exists login_ciphertext text,
        add column if not exists server_ciphertext text,
        add column if not exists password_fingerprint text,
        add column if not exists metaapi_account_id text,
        add column if not exists last_connection_status text,
        add column if not exists last_deployment_state text,
        add column if not exists last_validated_at timestamptz
    `);

    await pool.query(`
      create unique index if not exists metaapi_account_registry_fingerprint_idx
        on metaapi_account_registry(credential_fingerprint)
    `);

    await pool.query(`
      create unique index if not exists saved_accounts_user_label_type_idx
        on saved_accounts(user_id, label, account_type)
    `);

    await pool.query(`
      alter table if exists hedging_slots
        alter column seat_id drop not null
    `);
  } catch (error) {
    logger.warn({ error }, "Database compatibility bootstrap skipped");
  }
}
