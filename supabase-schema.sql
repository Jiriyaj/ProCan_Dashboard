-- ProCan J.A.I.D.A — Minimal Ops Schema (Orders → Auto-Assign → Map)
-- This patch is SAFE to run multiple times.

-- 1) Orders: add geo + zone fields (map needs this)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS lat double precision,
  ADD COLUMN IF NOT EXISTS lng double precision,
  ADD COLUMN IF NOT EXISTS zone text;

-- 2) Assignments: MUST allow recurring service
--    The dashboard upserts by (order_id, service_date).
--    If you currently have UNIQUE(order_id), replace it with UNIQUE(order_id, service_date).

DO $$
BEGIN
  -- drop old unique constraint on order_id if it exists (name can vary, so check)
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.assignments'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) LIKE '%(order_id)%'
      AND pg_get_constraintdef(oid) NOT LIKE '%(order_id, service_date)%'
  ) THEN
    -- find and drop all single-column unique constraints on order_id
    FOR r IN (
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'public.assignments'::regclass
        AND contype = 'u'
        AND pg_get_constraintdef(oid) LIKE '%(order_id)%'
        AND pg_get_constraintdef(oid) NOT LIKE '%(order_id, service_date)%'
    ) LOOP
      EXECUTE format('ALTER TABLE public.assignments DROP CONSTRAINT %I', r.conname);
    END LOOP;
  END IF;
END $$;

ALTER TABLE public.assignments
  ADD CONSTRAINT IF NOT EXISTS assignments_order_id_service_date_key UNIQUE (order_id, service_date);

-- 3) RLS: allow authenticated access (only if you don't already have policies)
ALTER TABLE public.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assignments ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='orders' AND policyname='orders_authed_all') THEN
    CREATE POLICY orders_authed_all ON public.orders
      FOR ALL USING (auth.role() = 'authenticated')
      WITH CHECK (auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='assignments' AND policyname='assignments_authed_all') THEN
    CREATE POLICY assignments_authed_all ON public.assignments
      FOR ALL USING (auth.role() = 'authenticated')
      WITH CHECK (auth.role() = 'authenticated');
  END IF;
END $$;


-- 3) Assignments: ordering within a day
ALTER TABLE public.assignments ADD COLUMN IF NOT EXISTS stop_order integer DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_assignments_date_order ON public.assignments(service_date, stop_order);


-- 4) Orders: scheduling metadata (route rhythm + lifecycle)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS is_deposit boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS service_day integer,               -- 0=Sun..6=Sat
  ADD COLUMN IF NOT EXISTS route_start_date date,            -- anchor date for every-other-week rhythm
  ADD COLUMN IF NOT EXISTS last_service_date date,           -- updated when a job is completed
  ADD COLUMN IF NOT EXISTS route_operator_id uuid;           -- preferred operator for this route/order

-- Orders: lifecycle (prevent "zombie" re-creates from webhooks)
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;



-- 5) ROUTE-FIRST: routes table + orders.route_id
CREATE TABLE IF NOT EXISTS public.routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  service_day text,
  status text NOT NULL DEFAULT 'draft', -- draft|ready|active|completed
  target_cans integer,
  operator_id uuid
);

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS route_id uuid;

-- Optional FK (safe if you want referential integrity)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'orders_route_id_fkey'
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_route_id_fkey
      FOREIGN KEY (route_id) REFERENCES public.routes(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_orders_route_id ON public.orders(route_id);

ALTER TABLE public.routes ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='routes' AND policyname='routes_authed_all') THEN
    CREATE POLICY routes_authed_all ON public.routes
      FOR ALL USING (auth.role() = 'authenticated')
      WITH CHECK (auth.role() = 'authenticated');
  END IF;
END $$;


-- Route scheduling fields
alter table public.routes
  add column if not exists service_start_date date,
  add column if not exists cadence text not null default 'biweekly',
  add column if not exists last_service_date date;

-- Optional geocoding fields on orders (for precise routing)
alter table public.orders
  add column if not exists lat double precision,
  add column if not exists lng double precision;

-- Service/billing fields (service cadence is biweekly|monthly; billing cadence is monthly|quarterly|annual)
alter table public.orders
  add column if not exists service_frequency text,
  add column if not exists billing_interval text;

-- Order lifecycle (prevents "zombie" orders reappearing)
alter table public.orders
  add column if not exists is_deleted boolean not null default false,
  add column if not exists deleted_at timestamptz,
  add column if not exists cancelled_at timestamptz;


-- 6) SERVICE CONFIRMATION: route_runs + route_run_stops
--    A "run" represents one service date for a route.
--    Stops are the orders that should be serviced for that run.

CREATE TABLE IF NOT EXISTS public.route_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  route_id uuid NOT NULL REFERENCES public.routes(id) ON DELETE CASCADE,
  service_date date NOT NULL,
  status text NOT NULL DEFAULT 'in_progress', -- in_progress|completed
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_by uuid
);

ALTER TABLE public.route_runs
  ADD CONSTRAINT IF NOT EXISTS route_runs_route_id_service_date_key UNIQUE (route_id, service_date);

CREATE INDEX IF NOT EXISTS idx_route_runs_route_date ON public.route_runs(route_id, service_date);


CREATE TABLE IF NOT EXISTS public.route_run_stops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  run_id uuid NOT NULL REFERENCES public.route_runs(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES public.orders(id) ON DELETE RESTRICT,
  stop_order integer NOT NULL DEFAULT 0,
  arrived boolean NOT NULL DEFAULT false,
  cleaned boolean NOT NULL DEFAULT false,
  photo_before boolean NOT NULL DEFAULT false,
  photo_after boolean NOT NULL DEFAULT false,
  completed boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  notes text
);

ALTER TABLE public.route_run_stops
  ADD CONSTRAINT IF NOT EXISTS route_run_stops_run_order_key UNIQUE (run_id, order_id);

CREATE INDEX IF NOT EXISTS idx_route_run_stops_run_order ON public.route_run_stops(run_id, stop_order);


-- RLS (authenticated only) — matches the rest of the dashboard model
ALTER TABLE public.route_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.route_run_stops ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='route_runs' AND policyname='route_runs_authed_all') THEN
    CREATE POLICY route_runs_authed_all ON public.route_runs
      FOR ALL USING (auth.role() = 'authenticated')
      WITH CHECK (auth.role() = 'authenticated');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='route_run_stops' AND policyname='route_run_stops_authed_all') THEN
    CREATE POLICY route_run_stops_authed_all ON public.route_run_stops
      FOR ALL USING (auth.role() = 'authenticated')
      WITH CHECK (auth.role() = 'authenticated');
  END IF;
END $$;

