-- Client lifecycle status: activo | dormant | cerrado.
-- Lets the global dashboard focus KPIs on active deals and exclude dormant/closed
-- clients from "EEFF/docs vencidos" and the watchlist.
-- Safe / re-runnable.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'activo';

-- Guard against typos at the DB level.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_status_check'
  ) THEN
    ALTER TABLE clients
      ADD CONSTRAINT clients_status_check
      CHECK (status IN ('activo', 'dormant', 'cerrado'));
  END IF;
END $$;

-- Backfill any pre-existing NULLs (should be none given the default).
UPDATE clients SET status = 'activo' WHERE status IS NULL;
