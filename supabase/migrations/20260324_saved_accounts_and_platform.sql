alter table if exists trading_accounts
  add column if not exists platform text not null default 'mt5';

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
);

create unique index if not exists saved_accounts_user_label_type_idx
  on saved_accounts(user_id, label, account_type);
