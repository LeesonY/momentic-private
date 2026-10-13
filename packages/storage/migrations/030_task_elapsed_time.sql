-- Historical tasks have no precise times; preserve NULL instead of inventing.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS finished_at timestamptz;
