-- Concierge 2.0, phase 1 (docs/CONCIERGE_2_PLAN.md): richer tasks, and routines with a cadence (daily / weekly / monthly).
-- ADDITIVE except two CHECKs that are widened or replaced. Reversal, in this order:
--   ALTER TABLE routines DROP COLUMN day_of_month; ALTER TABLE routines DROP COLUMN weekday; ALTER TABLE routines DROP COLUMN cadence;
--   ALTER TABLE routines DROP CONSTRAINT routines_kind_format;
--   ALTER TABLE routines ADD CONSTRAINT routines_kind_check CHECK (kind IN ('research_digest', 'daily_quote', 'ml_challenge', 'market_watch'));
--   ALTER TABLE tasks DROP COLUMN archived_at; ALTER TABLE tasks DROP COLUMN snoozed_until; ALTER TABLE tasks DROP COLUMN category; ALTER TABLE tasks DROP COLUMN priority;
--   (first move any ARCHIVED task back to 'OPEN', then:)
--   ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
--   ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('OPEN', 'DONE', 'DELETED'));

-- Tasks: priority and category are the PERSON's words (NULL = not said); a snoozed task is hidden until its date; an archived task is kept, not deleted.
ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('OPEN', 'DONE', 'DELETED', 'ARCHIVED'));
ALTER TABLE tasks ADD COLUMN priority text CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT'));
ALTER TABLE tasks ADD COLUMN category text CHECK (category IS NULL OR length(category) BETWEEN 1 AND 40);
ALTER TABLE tasks ADD COLUMN snoozed_until timestamptz;
ALTER TABLE tasks ADD COLUMN archived_at timestamptz;

-- Routines: the kind stops being a fixed list in the database (the code knows the kinds it can run); a cadence says how often.
-- The idempotency key stays routine_runs.run_date, which becomes the START of the period (the day for daily, the chosen weekday for weekly, the chosen day for monthly).
ALTER TABLE routines DROP CONSTRAINT routines_kind_check;
ALTER TABLE routines ADD CONSTRAINT routines_kind_format CHECK (kind ~ '^[a-z][a-z0-9_]{2,40}$');
ALTER TABLE routines ADD COLUMN cadence text NOT NULL DEFAULT 'daily' CHECK (cadence IN ('daily', 'weekly', 'monthly'));
ALTER TABLE routines ADD COLUMN weekday smallint CHECK (weekday BETWEEN 0 AND 6);          -- 0 = Sunday; used by weekly
ALTER TABLE routines ADD COLUMN day_of_month smallint CHECK (day_of_month BETWEEN 1 AND 28); -- used by monthly (28 max: every month has it)
ALTER TABLE routines ADD CONSTRAINT routines_cadence_fields CHECK (
  (cadence = 'daily'   AND weekday IS NULL AND day_of_month IS NULL) OR
  (cadence = 'weekly'  AND weekday IS NOT NULL AND day_of_month IS NULL) OR
  (cadence = 'monthly' AND weekday IS NULL AND day_of_month IS NOT NULL)
);
