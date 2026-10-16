-- Daily routines: something Wendy does once a day, at the person's time, and keeps the result of.
-- ADDITIVE ONLY: new tables, no existing table is altered. Reversal (reverse dependency order):
--   DROP TABLE digest_items; DROP TABLE routine_runs; DROP TABLE routines;
-- See docs/DAILY_ROUTINES_SCHEMA.md.

CREATE TABLE routines (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  kind         text NOT NULL CHECK (kind IN ('research_digest', 'daily_quote', 'ml_challenge')),
  enabled      boolean NOT NULL DEFAULT true,
  local_time   time NOT NULL DEFAULT '07:30',
  timezone     text NOT NULL DEFAULT 'America/Sao_Paulo',
  paused_until timestamptz,
  config       jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  UNIQUE (principal_id, kind)
);

CREATE TABLE routine_runs (
  id           uuid PRIMARY KEY,
  routine_id   uuid NOT NULL REFERENCES routines(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  -- The LOCAL date in the routine's timezone: the idempotency key. One run per routine per local day.
  run_date     date NOT NULL,
  status       text NOT NULL CHECK (status IN ('RUNNING', 'DONE', 'FAILED')),
  attempts     integer NOT NULL DEFAULT 1,
  lease_until  timestamptz,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz,
  error        text,
  UNIQUE (routine_id, run_date)
);
CREATE INDEX routine_runs_principal_idx ON routine_runs (principal_id, run_date DESC);

CREATE TABLE digest_items (
  id           uuid PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES routine_runs(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  kind         text NOT NULL CHECK (kind IN ('article', 'quote', 'challenge')),
  source_name  text NOT NULL,
  source_url   text NOT NULL,
  title        text NOT NULL,
  published_at timestamptz,
  summary      text,
  why          text,
  score        real,
  evidence     jsonb NOT NULL DEFAULT '{}',
  answered_at  timestamptz,
  read_at      timestamptz,
  created_at   timestamptz NOT NULL,
  UNIQUE (principal_id, source_url)
);
CREATE INDEX digest_items_unread ON digest_items (principal_id, created_at DESC) WHERE read_at IS NULL;
