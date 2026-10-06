-- Wendy Cognitive Core — initial schema.
-- Every table is scoped by principal_id (the executive Wendy works for).

CREATE TABLE principals (
  id            uuid PRIMARY KEY,
  display_name  text NOT NULL,
  primary_email text NOT NULL,
  timezone      text NOT NULL,
  locale        text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organizations (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  name         text NOT NULL,
  domain       text,
  source       text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE people (
  id              uuid PRIMARY KEY,
  principal_id    uuid NOT NULL REFERENCES principals(id),
  full_name       text NOT NULL,
  title           text,
  organization_id uuid REFERENCES organizations(id),
  birthdate       date,
  source          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX people_principal_idx ON people(principal_id);

-- Identifiers used for deterministic entity resolution (email today; phone/handles later).
CREATE TABLE person_identifiers (
  principal_id uuid NOT NULL REFERENCES principals(id),
  kind         text NOT NULL,
  value        text NOT NULL,          -- normalized (lowercased, trimmed)
  person_id    uuid NOT NULL REFERENCES people(id),
  PRIMARY KEY (principal_id, kind, value)
);

-- The principal's relationship with a person. explicit_importance is set by the principal (or fixture data),
-- never by code heuristics.
CREATE TABLE relationships (
  id                  uuid PRIMARY KEY,
  principal_id        uuid NOT NULL REFERENCES principals(id),
  person_id           uuid NOT NULL REFERENCES people(id),
  kind                text NOT NULL,
  explicit_importance numeric CHECK (explicit_importance BETWEEN 0 AND 1),
  notes               text,
  source              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (principal_id, person_id)
);

CREATE TABLE messages (
  id                 uuid PRIMARY KEY,
  principal_id       uuid NOT NULL REFERENCES principals(id),
  provider           text NOT NULL,
  external_id        text NOT NULL,
  thread_external_id text,
  direction          text NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  from_address       text NOT NULL,
  to_addresses       text[] NOT NULL,
  subject            text NOT NULL,
  body               text NOT NULL,
  sent_at            timestamptz NOT NULL,
  ingested_at        timestamptz NOT NULL DEFAULT now(),
  search             tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(subject, '') || ' ' || coalesce(body, ''))) STORED,
  UNIQUE (principal_id, provider, external_id)
);
CREATE INDEX messages_search_idx ON messages USING gin(search);
CREATE INDEX messages_sent_idx ON messages(principal_id, sent_at DESC);

-- Which known people participate in a message (resolved from addresses at ingestion).
CREATE TABLE message_participants (
  message_id uuid NOT NULL REFERENCES messages(id),
  person_id  uuid NOT NULL REFERENCES people(id),
  role       text NOT NULL CHECK (role IN ('FROM', 'TO')),
  PRIMARY KEY (message_id, person_id, role)
);

CREATE TABLE meetings (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  provider     text NOT NULL,
  external_id  text NOT NULL,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  status       text NOT NULL CHECK (status IN ('CONFIRMED', 'TENTATIVE', 'CANCELLED')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  search       tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED,
  UNIQUE (principal_id, provider, external_id)
);
CREATE INDEX meetings_search_idx ON meetings USING gin(search);

CREATE TABLE meeting_attendees (
  meeting_id uuid NOT NULL REFERENCES meetings(id),
  address    text NOT NULL,
  person_id  uuid REFERENCES people(id),
  PRIMARY KEY (meeting_id, address)
);

CREATE TABLE commitments (
  id                     uuid PRIMARY KEY,
  principal_id           uuid NOT NULL REFERENCES principals(id),
  owner                  text NOT NULL CHECK (owner IN ('PRINCIPAL', 'COUNTERPARTY')),
  counterparty_person_id uuid NOT NULL REFERENCES people(id),
  description            text NOT NULL,
  due_at                 timestamptz NOT NULL,
  status                 text NOT NULL CHECK (status IN ('OPEN', 'DONE', 'CANCELLED')),
  source_message_id      uuid REFERENCES messages(id),
  source                 text NOT NULL,
  created_at             timestamptz NOT NULL,
  completed_at           timestamptz,
  search                 tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(description, ''))) STORED
);
CREATE INDEX commitments_search_idx ON commitments USING gin(search);

-- Canonical event store. (principal_id, source, source_event_key) makes ingestion idempotent.
CREATE TABLE events (
  id                  uuid PRIMARY KEY,
  principal_id        uuid NOT NULL REFERENCES principals(id),
  event_type          text NOT NULL,
  source              text NOT NULL,
  source_event_key    text NOT NULL,
  occurred_at         timestamptz NOT NULL,
  received_at         timestamptz NOT NULL,
  actor               jsonb NOT NULL,
  entity_refs         jsonb NOT NULL DEFAULT '[]',
  payload             jsonb NOT NULL,
  payload_hash        text NOT NULL,
  confidence          numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  provenance          jsonb NOT NULL,
  correlation_id      uuid NOT NULL,
  permissions         jsonb NOT NULL,
  processing_status   text NOT NULL DEFAULT 'PENDING'
                      CHECK (processing_status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'SKIPPED', 'FAILED')),
  processing_attempts int NOT NULL DEFAULT 0,
  locked_until        timestamptz,
  last_error          text,
  processed_at        timestamptz,
  UNIQUE (principal_id, source, source_event_key)
);
CREATE INDEX events_pending_idx ON events(processing_status, received_at);

CREATE TABLE memories (
  id                uuid PRIMARY KEY,
  principal_id      uuid NOT NULL REFERENCES principals(id),
  kind              text NOT NULL CHECK (kind IN ('PREFERENCE', 'FACT', 'EPISODE', 'OUTCOME')),
  subject_person_id uuid REFERENCES people(id),
  content           text NOT NULL,
  confidence        numeric NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status            text NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'RETRACTED')),
  evidence          jsonb NOT NULL,       -- [{kind, id}] records that support this memory
  written_by        text NOT NULL,        -- PRINCIPAL | WENDY | SYSTEM
  created_at        timestamptz NOT NULL,
  superseded_by     uuid REFERENCES memories(id),
  search            tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED
);
CREATE INDEX memories_search_idx ON memories USING gin(search);
CREATE INDEX memories_subject_idx ON memories(principal_id, subject_person_id);

-- Every Claude call, so "Claude was really called" and "what context did it get" are verifiable.
CREATE TABLE model_calls (
  id                  uuid PRIMARY KEY,
  principal_id        uuid NOT NULL REFERENCES principals(id),
  purpose             text NOT NULL,
  model               text NOT NULL,
  served_by_model     text,
  api_message_id      text,
  prompt_version      text NOT NULL,
  input               jsonb NOT NULL,
  input_evidence_refs jsonb NOT NULL,
  output              jsonb,
  stop_reason         text,
  usage               jsonb,
  error               text,
  started_at          timestamptz NOT NULL,
  finished_at         timestamptz
);

CREATE TABLE insights (
  id              uuid PRIMARY KEY,
  principal_id    uuid NOT NULL REFERENCES principals(id),
  event_id        uuid NOT NULL UNIQUE REFERENCES events(id),
  correlation_id  uuid NOT NULL,
  status          text NOT NULL CHECK (status IN ('SURFACED', 'SUPPRESSED', 'REJECTED_BY_VALIDATION')),
  headline        text,
  narrative       text,
  rendered        text NOT NULL,
  salience        jsonb NOT NULL,
  validation      jsonb NOT NULL,
  understanding   jsonb,
  evidence_map    jsonb NOT NULL,       -- handle -> {kind, id}
  model_call_ids  uuid[] NOT NULL,
  created_at      timestamptz NOT NULL
);

CREATE TABLE claims (
  id               uuid PRIMARY KEY,
  insight_id       uuid NOT NULL REFERENCES insights(id),
  ordinal          int NOT NULL,
  label            text NOT NULL,        -- 'F:<handle>' for code facts, model claim id (C1..) otherwise
  kind             text NOT NULL CHECK (kind IN ('FACT', 'INFERENCE', 'HYPOTHESIS', 'ANTICIPATION', 'RECOMMENDATION')),
  statement        text NOT NULL,
  confidence       numeric NOT NULL,
  evidence         jsonb NOT NULL,       -- [{handle, kind, id}]
  derived_from     int[] NOT NULL,
  produced_by      text NOT NULL CHECK (produced_by IN ('CODE', 'CLAUDE')),
  validation_status text NOT NULL CHECK (validation_status IN ('VALID', 'REJECTED')),
  validation_errors jsonb NOT NULL,
  UNIQUE (insight_id, ordinal)
);

CREATE TABLE actions (
  id                  uuid PRIMARY KEY,
  principal_id        uuid NOT NULL REFERENCES principals(id),
  insight_id          uuid REFERENCES insights(id),
  action_type         text NOT NULL,
  target_person_id    uuid REFERENCES people(id),
  state               text NOT NULL,
  authorization_level int NOT NULL,
  policy_decision     jsonb NOT NULL,
  current_version     int NOT NULL,
  expires_at          timestamptz,
  rejection_reason    text,
  failure             text,
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL
);

CREATE TABLE action_versions (
  action_id    uuid NOT NULL REFERENCES actions(id),
  version      int NOT NULL,
  content      jsonb NOT NULL,
  content_hash text NOT NULL,
  author       text NOT NULL CHECK (author IN ('WENDY', 'PRINCIPAL')),
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (action_id, version)
);

CREATE TABLE action_transitions (
  id         bigserial PRIMARY KEY,
  action_id  uuid NOT NULL REFERENCES actions(id),
  from_state text,
  to_state   text NOT NULL,
  actor      text NOT NULL,
  reason     text,
  at         timestamptz NOT NULL
);

-- At most one execution per action, ever (UNIQUE action_id). The idempotency key is handed to the provider.
CREATE TABLE action_executions (
  id              uuid PRIMARY KEY,
  action_id       uuid NOT NULL UNIQUE REFERENCES actions(id),
  idempotency_key text NOT NULL UNIQUE,
  version         int NOT NULL,
  content_hash    text NOT NULL,
  provider        text NOT NULL,
  status          text NOT NULL CHECK (status IN ('PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED')),
  provider_ref    text,
  attempts        int NOT NULL DEFAULT 0,
  last_error      text,
  verification    jsonb,
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- Internal work products (e.g. briefings) produced by executed internal actions.
CREATE TABLE artifacts (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  action_id    uuid NOT NULL UNIQUE REFERENCES actions(id),
  kind         text NOT NULL,
  content      jsonb NOT NULL,
  content_hash text NOT NULL,
  created_at   timestamptz NOT NULL
);

-- DEV ONLY outbound sink: a local "mailbox" provider. Rows here were NOT delivered to anyone.
CREATE TABLE dev_outbound_mail (
  id              uuid PRIMARY KEY,
  principal_id    uuid NOT NULL REFERENCES principals(id),
  idempotency_key text NOT NULL UNIQUE,
  to_addresses    text[] NOT NULL,
  subject         text NOT NULL,
  body            text NOT NULL,
  accepted_at     timestamptz NOT NULL
);

-- Hash-chained audit ledger. audit_head anchors the tip so truncation is detectable.
CREATE TABLE audit_blocks (
  seq        bigint PRIMARY KEY,
  at         timestamptz NOT NULL,
  principal_id uuid,
  event_type text NOT NULL,
  actor      text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  payload    jsonb NOT NULL,
  prev_hash  text NOT NULL,
  hash       text NOT NULL
);

CREATE TABLE audit_head (
  id   int PRIMARY KEY CHECK (id = 1),
  seq  bigint NOT NULL,
  hash text NOT NULL
);
