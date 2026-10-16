-- Market MONITORING (never advice): which assets are watched, and the unusual-movement observations raised about them.
-- Two new tables, plus ONE widened CHECK on routines (the daily scheduler is reused for the market sweep). Reversal, in this order:
--   DROP TABLE market_alerts; DROP TABLE watchlist;
--   ALTER TABLE routines DROP CONSTRAINT routines_kind_check;
--   ALTER TABLE routines ADD CONSTRAINT routines_kind_check CHECK (kind IN ('research_digest', 'daily_quote', 'ml_challenge'));

ALTER TABLE routines DROP CONSTRAINT routines_kind_check;
ALTER TABLE routines ADD CONSTRAINT routines_kind_check CHECK (kind IN ('research_digest', 'daily_quote', 'ml_challenge', 'market_watch'));

CREATE TABLE watchlist (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  symbol       text NOT NULL CHECK (symbol ~ '^[A-Z0-9]{1,8}$'),
  market       text NOT NULL CHECK (market IN ('B3', 'US')),
  -- liquidity: picked from the most traded B3 assets (refreshed weekly); config: named in config/market-watch.json
  source       text NOT NULL CHECK (source IN ('liquidity', 'config')),
  active       boolean NOT NULL DEFAULT true,
  last_volume  numeric,
  updated_at   timestamptz NOT NULL,
  UNIQUE (principal_id, symbol)
);

CREATE TABLE market_alerts (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  symbol       text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('MOVE_OUTLIER', 'VOLUME_SPIKE', 'RANGE_EXPANSION')),
  -- The candle the observation is about (the same candle never raises the same alert twice).
  observed_at  timestamptz NOT NULL,
  value        double precision NOT NULL,
  threshold    double precision NOT NULL,
  explanation  text NOT NULL,
  created_at   timestamptz NOT NULL,
  seen_at      timestamptz,
  UNIQUE (principal_id, symbol, kind, observed_at)
);
CREATE INDEX market_alerts_recent ON market_alerts (principal_id, created_at DESC);
