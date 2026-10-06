-- Phase 2 (deterministic part): memory lifecycle with the principal in the loop, per-principal
-- approval policy overrides, and authenticated UI sessions for the write API.

-- Memories: PROPOSED (deduced, awaiting the principal) → ACTIVE (confirmed) → SUPERSEDED / RETRACTED.
ALTER TABLE memories DROP CONSTRAINT memories_status_check;
ALTER TABLE memories ADD CONSTRAINT memories_status_check CHECK (status IN ('PROPOSED', 'ACTIVE', 'SUPERSEDED', 'RETRACTED'));
ALTER TABLE memories ADD COLUMN last_confirmed_at timestamptz;
ALTER TABLE memories ADD COLUMN confirmed_by text;
ALTER TABLE memories ADD COLUMN status_changed_at timestamptz;
ALTER TABLE memories ADD COLUMN status_reason text;
-- Memories written before this migration were active and are treated as confirmed at creation.
UPDATE memories SET last_confirmed_at = created_at WHERE status = 'ACTIVE';

-- Contradictions between memories, reported with evidence and resolved by the principal.
CREATE TABLE memory_conflicts (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  memory_ids   uuid[] NOT NULL,
  description  text NOT NULL,
  source       jsonb NOT NULL,                -- {kind:'insight'|'answer', id}
  status       text NOT NULL CHECK (status IN ('OPEN', 'RESOLVED')),
  detected_at  timestamptz NOT NULL,
  resolved_at  timestamptz,
  resolution   jsonb
);
CREATE INDEX memory_conflicts_open_idx ON memory_conflicts(principal_id, status);

-- Per-principal approval policy overrides (absent row = catalog default).
CREATE TABLE approval_policies (
  principal_id uuid NOT NULL REFERENCES principals(id),
  action_type  text NOT NULL,
  mode         text NOT NULL CHECK (mode IN ('AUTO', 'REQUIRE_APPROVAL')),
  updated_at   timestamptz NOT NULL,
  updated_by   text NOT NULL,
  PRIMARY KEY (principal_id, action_type)
);

-- Authenticated UI sessions (only token hashes are stored).
CREATE TABLE ui_sessions (
  id          uuid PRIMARY KEY,
  token_hash  text NOT NULL UNIQUE,
  csrf_token  text NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
