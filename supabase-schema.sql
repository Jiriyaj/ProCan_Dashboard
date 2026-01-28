-- =========================
-- Core tables
-- =========================

create table if not exists public.operators (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  payout_rate numeric not null default 30,
  is_manager boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),

  -- Stripe identifiers
  stripe_session_id text unique,
  order_id text, -- your internal orderId from metadata

  -- customer + business info
  biz_name text,
  contact_name text,
  customer_email text,
  phone text,
  address text,
  locations_count int,
  preferred_service_day text,
  start_date text,
  notes text,

  -- service details
  billing_type text,       -- one_time | subscription
  billing text,            -- monthly|quarterly|annual
  term_months int,
  cadence text,            -- biweekly|monthly etc
  cans text,

  pad_enabled boolean,
  pad_size text,
  pad_cadence text,

  deep_clean_enabled boolean,
  deep_clean_level text,
  deep_clean_qty text,
  deep_clean_total numeric,

  discount_code text,
  monthly_total numeric,
  due_today numeric,

  terms_url text,

  -- ops
  status text not null default 'new', -- new|scheduled|completed|cancelled
  created_at timestamptz not null default now()
);

create table if not exists public.assignments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  operator_id uuid not null references public.operators(id) on delete restrict,
  service_date date not null,
  sequence int not null default 1,
  completed_at timestamptz,
  completion_notes text,
  created_at timestamptz not null default now(),
  unique(order_id) -- each order can only be assigned once (MVP)
);

-- Optional: store completed visits (if you want your "Log Completed Job" to persist)
create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid references public.operators(id) on delete set null,
  customer_name text not null,
  service_date date not null,
  service_type text,
  quantity int,
  billing_frequency text,
  locations_count int,
  job_type text, -- recurring|oneTime
  visit_revenue numeric,
  fees numeric,
  payout_status text, -- due|paid|cancelled
  deep_clean_enabled boolean,
  deep_clean_condition text,
  deep_clean_total numeric,
  created_at timestamptz not null default now()
);

-- =========================
-- RLS (Lock it down)
-- =========================
alter table public.operators enable row level security;
alter table public.orders enable row level security;
alter table public.assignments enable row level security;
alter table public.visits enable row level security;

-- For MVP: only authenticated users can read/write everything.
create policy "operators_authed_all"
on public.operators for all
to anon, authenticated
using (true)
with check (true);

create policy "orders_authed_all"
on public.orders for all
to anon, authenticated
using (true)
with check (true);

create policy "assignments_authed_all"
on public.assignments for all
to anon, authenticated
using (true)
with check (true);

create policy "visits_authed_all"
on public.visits for all
to anon, authenticated
using (true)
with check (true);


-- =========================
-- Routing + Onboarding (v2)
-- =========================

create table if not exists public.routes (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  zone text not null default 'default',

  frequency_type text not null default 'biweekly_a', -- biweekly_a|biweekly_b|monthly
  monthly_week int, -- 1..4 when monthly

  operator_id uuid references public.operators(id) on delete set null,
  capacity_stops int,
  capacity_cans int,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  biz_name text,
  contact_name text,
  customer_email text,
  phone text,
  address text,
  zone text not null default 'default',
  frequency text not null default 'monthly', -- monthly|biweekly
  cans int not null default 0,

  status text not null default 'deposited', -- lead|deposited|scheduled|active|paused|cancelled
  deposit_amount numeric not null default 25,
  deposit_paid_at timestamptz,
  route_id uuid references public.routes(id) on delete set null,
  start_week_start date, -- week-start date (cycle week start) for first service

  created_at timestamptz not null default now()
);

create table if not exists public.route_stops (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references public.routes(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  sequence int not null default 999,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(route_id, customer_id)
);

create table if not exists public.settings (
  key text primary key,
  value jsonb not null
);

-- Enable RLS
alter table public.customers enable row level security;
alter table public.routes enable row level security;
alter table public.route_stops enable row level security;
alter table public.settings enable row level security;

create policy "customers_authed_all"
on public.customers for all
to anon, authenticated
using (true)
with check (true);

create policy "routes_authed_all"
on public.routes for all
to anon, authenticated
using (true)
with check (true);

create policy "route_stops_authed_all"
on public.route_stops for all
to anon, authenticated
using (true)
with check (true);

create policy "settings_authed_all"
on public.settings for all
to anon, authenticated
using (true)
with check (true);

-- Seed default settings if not present
insert into public.settings (key, value)
values
  ('cycle_anchor', to_jsonb('2026-04-01'::text)),
  ('lock_window_days', to_jsonb(7))
on conflict (key) do nothing;


-- =========================
-- Grants (MVP: allow anon dashboard access)
-- =========================
grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;




-- =========================
-- Schema extensions for deposits + saved payment methods (v3)
-- =========================
do $$
begin
  -- orders extensions
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='stripe_customer_id') then
    alter table public.orders add column stripe_customer_id text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='stripe_payment_intent_id') then
    alter table public.orders add column stripe_payment_intent_id text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='stripe_subscription_id') then
    alter table public.orders add column stripe_subscription_id text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='is_deposit') then
    alter table public.orders add column is_deposit boolean not null default false;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='deposit_amount') then
    alter table public.orders add column deposit_amount numeric;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='normal_due_today') then
    alter table public.orders add column normal_due_today numeric;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='orders' and column_name='checkout_mode') then
    alter table public.orders add column checkout_mode text; -- payment|subscription|setup
  end if;

  -- customers extensions
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='customers' and column_name='stripe_customer_id') then
    alter table public.customers add column stripe_customer_id text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='customers' and column_name='stripe_subscription_id') then
    alter table public.customers add column stripe_subscription_id text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='customers' and column_name='pm_saved') then
    alter table public.customers add column pm_saved boolean not null default false;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='customers' and column_name='preferred_window') then
    alter table public.customers add column preferred_window text;
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='customers' and column_name='start_after') then
    alter table public.customers add column start_after date;
  end if;

  -- routes service window extensions
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='routes' and column_name='window_start_dow') then
    alter table public.routes add column window_start_dow int not null default 1; -- 0=Sun..6=Sat (cycle-week offset)
  end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='routes' and column_name='window_end_dow') then
    alter table public.routes add column window_end_dow int not null default 4;
  end if;

  -- unique key for customer upserts
  if not exists (select 1 from pg_constraint where conname='customers_stripe_customer_id_key') then
    alter table public.customers add constraint customers_stripe_customer_id_key unique (stripe_customer_id);
  end if;
end$$;
