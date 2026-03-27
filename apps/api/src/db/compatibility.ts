import { pool } from "./pool.js";
import { logger } from "../logger.js";

export async function ensureDatabaseCompatibility() {
  try {
    await pool.query("create extension if not exists pgcrypto");

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
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
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
