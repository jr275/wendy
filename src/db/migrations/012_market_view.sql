-- Market monitor, to be SEEN: keep the daily candles the sweep already fetches, let the person edit the watched list, and watch reference series.
-- ADDITIVE except two CHECKs that are widened. Reversal, in this order:
--   DROP TABLE market_candles;
--   ALTER TABLE watchlist DROP COLUMN role; ALTER TABLE watchlist DROP COLUMN excluded;
--   ALTER TABLE watchlist DROP CONSTRAINT watchlist_symbol_check;
--   ALTER TABLE watchlist ADD CONSTRAINT watchlist_symbol_check CHECK (symbol ~ '^[A-Z0-9]{1,8}$');
--   (first delete the 'user' rows: DELETE FROM watchlist WHERE source = 'user';)
--   ALTER TABLE watchlist DROP CONSTRAINT watchlist_source_check;
--   ALTER TABLE watchlist ADD CONSTRAINT watchlist_source_check CHECK (source IN ('liquidity', 'config'));

-- Daily candles, per person and symbol. The sweep upserts the history it already downloaded: no extra requests to the data provider.
CREATE TABLE market_candles (
  principal_id uuid NOT NULL REFERENCES principals(id),
  symbol       text NOT NULL,
  day          date NOT NULL,
  open         double precision NOT NULL,
  high         double precision NOT NULL,
  low          double precision NOT NULL,
  close        double precision NOT NULL,
  volume       double precision NOT NULL CHECK (volume >= 0),
  fetched_at   timestamptz NOT NULL,
  PRIMARY KEY (principal_id, symbol, day)
);

-- A person can add assets by hand (source 'user'), remove any asset for good (excluded survives the weekly refresh), and some rows are only
-- REFERENCE series (an index, a market ETF) shown for context: they are fetched and drawn but never raise alerts.
ALTER TABLE watchlist DROP CONSTRAINT watchlist_source_check;
ALTER TABLE watchlist ADD CONSTRAINT watchlist_source_check CHECK (source IN ('liquidity', 'config', 'user'));
ALTER TABLE watchlist DROP CONSTRAINT watchlist_symbol_check;
ALTER TABLE watchlist ADD CONSTRAINT watchlist_symbol_check CHECK (symbol ~ '^\^?[A-Z0-9]{1,8}$');
ALTER TABLE watchlist ADD COLUMN excluded boolean NOT NULL DEFAULT false;
ALTER TABLE watchlist ADD COLUMN role text NOT NULL DEFAULT 'asset' CHECK (role IN ('asset', 'reference'));
