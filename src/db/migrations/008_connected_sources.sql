-- Live sources the principal connected (Google: Gmail + Calendar, read-only). Sync state only:
-- OAuth tokens are NOT stored here (they live in a 0600 file outside the repo). Additive only.
CREATE TABLE connected_sources (
  principal_id          uuid NOT NULL REFERENCES principals(id),
  provider              text NOT NULL CHECK (provider IN ('google')),
  account_email         text NOT NULL,
  scopes                text[] NOT NULL,
  status                text NOT NULL CHECK (status IN ('CONNECTED', 'NEEDS_REAUTH', 'DISCONNECTED')),
  backfill_since        timestamptz,
  backfill_completed_at timestamptz,
  mail_synced_until     timestamptz,
  calendar_synced_at    timestamptz,
  last_error            text,
  connected_at          timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  PRIMARY KEY (principal_id, provider)
);
