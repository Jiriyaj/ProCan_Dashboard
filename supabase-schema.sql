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
