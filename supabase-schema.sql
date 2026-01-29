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

-- For production: require authenticated users.
create policy "operators_authed_all"
on public.operators for all
to authenticated
using (true)
with check (true);

create policy "orders_authed_all"
on public.orders for all
to authenticated
using (true)
with check (true);

create policy "assignments_authed_all"
on public.assignments for all
to authenticated
using (true)
with check (true);

create policy "visits_authed_all"
on public.visits for all
to authenticated
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
to authenticated
using (true)
with check (true);

create policy "routes_authed_all"
on public.routes for all
to authenticated
using (true)
with check (true);

create policy "route_stops_authed_all"
on public.route_stops for all
to authenticated
using (true)
with check (true);

create policy "settings_authed_all"
on public.settings for all
to authenticated
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
grant usage on schema public to authenticated;


-- =========================
-- Dispatch System (v3)
-- =========================

-- Link Supabase Auth users to an operator + role.
-- role: admin | dispatcher | operator
create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'admin',
  operator_id uuid references public.operators(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Users can read their own profile; only admins/dispatchers should manage others (kept simple here).
create policy "profiles_read_own"
on public.profiles for select
to authenticated
using (auth.uid() = user_id);

create policy "profiles_insert_own"
on public.profiles for insert
to authenticated
with check (auth.uid() = user_id);

-- NOTE: for production, tighten these with a custom JWT claim or a SQL function.
create policy "profiles_update_all_authed"
on public.profiles for update
to authenticated
using (true)
with check (true);


-- Leads (door-to-door) that can convert into customers
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  biz_name text,
  contact_name text,
  phone text,
  email text,
  address text not null,
  lat double precision,
  lng double precision,
  status text not null default 'new',
  -- new | presented | comeback | not_interested | dnk | sold
  follow_up_date date,
  follow_up_time time,
  notes text,
  assigned_operator_id uuid references public.operators(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists leads_status_idx on public.leads(status);
create index if not exists leads_followup_idx on public.leads(follow_up_date);

alter table public.leads enable row level security;
create policy "leads_authed_all"
on public.leads for all
to authenticated
using (true)
with check (true);


-- Add coordinates + service duration + time windows to customers (for routing)
alter table public.customers
  add column if not exists lat double precision,
  add column if not exists lng double precision,
  add column if not exists service_minutes int not null default 15,
  add column if not exists tw_start time,
  add column if not exists tw_end time;


-- Job instances (scheduled stops) for a specific date
-- Can reference either a customer or a lead.
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  job_date date not null,
  operator_id uuid references public.operators(id) on delete set null,

  customer_id uuid references public.customers(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,

  status text not null default 'scheduled',
  -- scheduled | en_route | in_progress | completed | skipped | cancelled

  planned_start timestamptz,
  planned_end timestamptz,
  actual_start timestamptz,
  actual_end timestamptz,

  stop_order int not null default 999,
  service_minutes int not null default 15,
  tw_start time,
  tw_end time,

  address text,
  lat double precision,
  lng double precision,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint jobs_target_chk check (
    (customer_id is not null and lead_id is null)
    or (customer_id is null and lead_id is not null)
    or (customer_id is null and lead_id is null)
  )
);

create index if not exists jobs_date_idx on public.jobs(job_date);
create index if not exists jobs_operator_idx on public.jobs(operator_id, job_date);

alter table public.jobs enable row level security;
create policy "jobs_authed_all"
on public.jobs for all
to authenticated
using (true)
with check (true);


-- Immutable audit trail for job lifecycle
create table if not exists public.job_events (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  event_type text not null,
  -- created | dispatched | started | completed | skipped | note | photo_added | reassigned
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.job_events enable row level security;
create policy "job_events_authed_all"
on public.job_events for all
to authenticated
using (true)
with check (true);


-- Job photos (store the file in Supabase Storage, keep pointer here)
create table if not exists public.job_photos (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  path text not null,
  caption text,
  created_at timestamptz not null default now()
);

alter table public.job_photos enable row level security;
create policy "job_photos_authed_all"
on public.job_photos for all
to authenticated
using (true)
with check (true);


-- Create a storage bucket for proof photos (run once)
-- In Supabase SQL editor:
--   insert into storage.buckets (id, name, public) values ('job-photos','job-photos', false) on conflict (id) do nothing;
-- Then add storage policies (requires Storage enabled).

grant all on all tables in schema public to authenticated;
grant all on all sequences in schema public to authenticated;




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
