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

