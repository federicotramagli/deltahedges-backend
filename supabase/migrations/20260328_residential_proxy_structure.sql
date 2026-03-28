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
  add column if not exists last_seen_region text;

update proxy_pool
set proxy_host = coalesce(nullif(proxy_host, ''), ip_address),
    proxy_protocol = coalesce(nullif(proxy_protocol, ''), 'http'),
    sticky_session_ttl_minutes = coalesce(sticky_session_ttl_minutes, 60)
where proxy_host is null
   or proxy_protocol is null
   or sticky_session_ttl_minutes is null;

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
);

create index if not exists proxy_verification_runs_proxy_id_idx
  on proxy_verification_runs(proxy_id, created_at desc);
