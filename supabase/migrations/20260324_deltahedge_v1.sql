create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'user_status') then
    create type user_status as enum ('ACTIVE', 'SUSPENDED');
  end if;
  if not exists (select 1 from pg_type where typname = 'proxy_status') then
    create type proxy_status as enum ('AVAILABLE', 'IN_USE', 'DISABLED');
  end if;
  if not exists (select 1 from pg_type where typname = 'slot_phase') then
    create type slot_phase as enum ('Fase 1', 'Fase 2', 'Funded');
  end if;
  if not exists (select 1 from pg_type where typname = 'slot_runtime_status') then
    create type slot_runtime_status as enum ('DRAFT', 'READY', 'RUNNING', 'PAUSED_MANUAL', 'PAUSED_BILLING', 'FUNDED_BREAK_EVEN_READY');
  end if;
  if not exists (select 1 from pg_type where typname = 'cycle_state') then
    create type cycle_state as enum ('FASE_1_ACTIVE', 'FASE_1_PASSED', 'FASE_1_FAILED', 'FASE_2_ACTIVE', 'FASE_2_PASSED', 'FASE_2_FAILED', 'FUNDED_ACTIVE', 'FUNDED_FAILED', 'FUNDED_PAYOUT', 'PAUSED_BILLING', 'FUNDED_BREAK_EVEN_READY');
  end if;
  if not exists (select 1 from pg_type where typname = 'subscription_status') then
    create type subscription_status as enum ('ACTIVE', 'PAST_DUE', 'CANCELED');
  end if;
  if not exists (select 1 from pg_type where typname = 'seat_status') then
    create type seat_status as enum ('ACTIVE', 'PAST_DUE', 'CANCELED');
  end if;
  if not exists (select 1 from pg_type where typname = 'account_type') then
    create type account_type as enum ('PROP', 'BROKER');
  end if;
  if not exists (select 1 from pg_type where typname = 'deployment_state') then
    create type deployment_state as enum ('NOT_DEPLOYED', 'DEPLOYING', 'DEPLOYED', 'DEPLOY_FAILED');
  end if;
  if not exists (select 1 from pg_type where typname = 'trade_pair_status') then
    create type trade_pair_status as enum ('PENDING', 'OPEN', 'CLOSED', 'ORPHAN_ABORTED');
  end if;
  if not exists (select 1 from pg_type where typname = 'trade_direction') then
    create type trade_direction as enum ('BUY', 'SELL');
  end if;
  if not exists (select 1 from pg_type where typname = 'risk_event_type') then
    create type risk_event_type as enum ('ORPHAN_ABORT', 'DISCONNECT', 'HARD_FAIL', 'PHASE_PASSED', 'FORCED_CLOSE', 'BILLING_PAUSE');
  end if;
  if not exists (select 1 from pg_type where typname = 'cycle_outcome') then
    create type cycle_outcome as enum ('FAIL_FASE_1', 'FAIL_FASE_2', 'FAIL_FUNDED', 'FUNDED_PAYOUT');
  end if;
end $$;

create table if not exists proxy_pool (
  id uuid primary key default gen_random_uuid(),
  ip_address text not null unique,
  country_code text not null,
  provider text not null,
  status proxy_status not null default 'AVAILABLE',
  assigned_user_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  billing_country text,
  proxy_id uuid references proxy_pool(id),
  metaapi_region text,
  status user_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  billing_country text,
  plan_name text not null,
  cadence text not null,
  renewal_date timestamptz,
  status subscription_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists subscription_seats (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  seat_number integer not null,
  status seat_status not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (subscription_id, seat_number)
);

create table if not exists hedging_slots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  seat_id uuid not null references subscription_seats(id),
  slot_name text not null,
  challenge text not null,
  phase slot_phase not null default 'Fase 1',
  runtime_status slot_runtime_status not null default 'DRAFT',
  cycle_state cycle_state not null default 'FASE_1_ACTIVE',
  challenge_state text not null default 'BOZZA',
  broker_account_name text,
  billing_country text,
  proxy_id uuid references proxy_pool(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists hedging_slots_user_slot_name_idx
  on hedging_slots(user_id, slot_name);

create table if not exists seat_allocations (
  id uuid primary key default gen_random_uuid(),
  seat_id uuid not null unique references subscription_seats(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_id uuid not null unique references hedging_slots(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  released_at timestamptz
);

create table if not exists trading_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_id uuid not null references hedging_slots(id) on delete cascade,
  account_type account_type not null,
  account_name text,
  login_ciphertext text not null,
  password_ciphertext text not null,
  server_ciphertext text not null,
  broker_lot_step numeric(12,4) not null default 0.01,
  metaapi_account_id text,
  deployment_state deployment_state not null default 'NOT_DEPLOYED',
  connection_status text not null default 'empty',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (slot_id, account_type)
);

create table if not exists slot_parameters (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null unique references hedging_slots(id) on delete cascade,
  parameters_profile text not null,
  phase1_base_target numeric(12,2) not null,
  broker_start_equity numeric(12,2) not null,
  risk_per_trade numeric(6,2) not null,
  max_daily_trades integer not null default 2,
  orphan_timeout_ms integer not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists slot_runtime (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null unique references hedging_slots(id) on delete cascade,
  current_target numeric(12,2) not null default 0,
  current_multiplier numeric(12,6) not null default 0,
  cycle_balance integer not null default 0,
  prop_equity numeric(12,2) not null default 0,
  broker_equity numeric(12,2) not null default 0,
  entry_schedule_json jsonb not null default '[]'::jsonb,
  forced_close_at timestamptz,
  last_entry_time timestamptz,
  trade_count_today integer not null default 0,
  current_trade_pair_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists trade_pairs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_id uuid not null references hedging_slots(id) on delete cascade,
  phase slot_phase not null,
  symbol text not null,
  direction trade_direction not null,
  status trade_pair_status not null default 'PENDING',
  prop_ticket_id text,
  broker_ticket_id text,
  prop_lot_size numeric(12,2) not null,
  broker_lot_raw numeric(12,6) not null,
  broker_lot_final numeric(12,2) not null,
  prop_realized_pnl numeric(12,2) not null default 0,
  broker_realized_pnl numeric(12,2) not null default 0,
  prop_unrealized_pnl numeric(12,2) not null default 0,
  broker_unrealized_pnl numeric(12,2) not null default 0,
  open_time timestamptz,
  close_time timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists risk_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_id uuid not null references hedging_slots(id) on delete cascade,
  cycle_id uuid,
  severity text not null,
  event_type risk_event_type not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists cycle_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  slot_id uuid not null references hedging_slots(id) on delete cascade,
  outcome cycle_outcome not null,
  broker_realized_profit numeric(12,2) not null default 0,
  prop_cost numeric(12,2) not null default 0,
  net_profit numeric(12,2) not null default 0,
  funded_gross_payout numeric(12,2),
  closed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists market_gap_memory (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references hedging_slots(id) on delete cascade,
  pair text not null,
  prop_execution_ms integer not null,
  broker_execution_ms integer not null,
  slippage_diff_pips numeric(12,4) not null,
  recorded_at timestamptz not null default now()
);

alter table slot_runtime
  add constraint slot_runtime_current_trade_pair_fk
  foreign key (current_trade_pair_id) references trade_pairs(id) on delete set null;
