-- Search Console sensor (read-only): the principal's web properties, aggregated metric windows
-- (last 7 days vs the 28 before) per page and query, and daily site totals for charts.

CREATE TABLE web_properties (
  id                  uuid PRIMARY KEY,
  principal_id        uuid NOT NULL REFERENCES principals(id),
  site_url            text NOT NULL,                 -- as in Search Console (https://… or sc-domain:…)
  label               text NOT NULL,
  explicit_importance real CHECK (explicit_importance IS NULL OR (explicit_importance >= 0 AND explicit_importance <= 1)),
  source              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_synced_at      timestamptz,
  UNIQUE (principal_id, site_url)
);

CREATE TABLE search_metric_windows (
  id            uuid PRIMARY KEY,
  principal_id  uuid NOT NULL REFERENCES principals(id),
  property_id   uuid NOT NULL REFERENCES web_properties(id),
  window_start  date NOT NULL,
  window_end    date NOT NULL,
  dimension     text NOT NULL CHECK (dimension IN ('total', 'page', 'query')),
  key           text NOT NULL,                       -- '' for total
  clicks        double precision NOT NULL,
  impressions   double precision NOT NULL,
  ctr           double precision NOT NULL,
  position      double precision NOT NULL,
  row_limit     integer NOT NULL,                    -- how many rows were fetched for this window/dimension
  fetched_at    timestamptz NOT NULL,
  UNIQUE (property_id, window_start, window_end, dimension, key)
);
CREATE INDEX search_metric_windows_lookup ON search_metric_windows(property_id, window_end, dimension);

CREATE TABLE search_daily_totals (
  property_id  uuid NOT NULL REFERENCES web_properties(id),
  date         date NOT NULL,
  clicks       double precision NOT NULL,
  impressions  double precision NOT NULL,
  ctr          double precision NOT NULL,
  position     double precision NOT NULL,
  fetched_at   timestamptz NOT NULL,
  PRIMARY KEY (property_id, date)
);
