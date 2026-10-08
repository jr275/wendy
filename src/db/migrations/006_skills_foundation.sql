-- Skills S1: runtime executions and their event log, the principal's tasks, captured web pages and
-- documents (citable evidence), and a "never" mode for approval policies.
-- Additive only: no existing column, row or table is dropped or rewritten.

-- Permission: the principal can forbid an action outright, not only require approval.
ALTER TABLE approval_policies DROP CONSTRAINT approval_policies_mode_check;
ALTER TABLE approval_policies ADD CONSTRAINT approval_policies_mode_check CHECK (mode IN ('AUTO', 'REQUIRE_APPROVAL', 'DENY'));

-- One run of one skill. Child runs (composition) point to their parent; root_id groups a tree.
-- The runtime persists the step cursor and step state after every step, and holds a lease while
-- running, so a run survives a process restart and resumes at the step it was on.
CREATE TABLE skill_executions (
  id            uuid PRIMARY KEY,
  principal_id  uuid NOT NULL REFERENCES principals(id),
  skill_id      text NOT NULL,
  skill_version text NOT NULL,
  parent_id     uuid REFERENCES skill_executions(id),
  root_id       uuid NOT NULL,
  status        text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_permission', 'waiting_child', 'completed', 'failed', 'cancelled')),
  input         jsonb NOT NULL,
  output        jsonb,
  error         jsonb,                      -- {code, message, step, retryable}
  state         jsonb NOT NULL DEFAULT '{}', -- step-owned state (e.g. ids of actions or children it waits on)
  step_index    int NOT NULL DEFAULT 0,
  wait          jsonb,                      -- {kind:'action'|'child', id} while waiting
  attempts      int NOT NULL DEFAULT 0,
  locked_until  timestamptz,
  lease_owner   text,
  trigger       jsonb NOT NULL,             -- what started it, e.g. {kind:'chat', question}
  created_at    timestamptz NOT NULL,
  started_at    timestamptz,
  updated_at    timestamptz NOT NULL,
  completed_at  timestamptz
);
CREATE INDEX skill_executions_ready_idx ON skill_executions(status, locked_until);
CREATE INDEX skill_executions_root_idx ON skill_executions(root_id);
CREATE INDEX skill_executions_principal_idx ON skill_executions(principal_id, created_at DESC);

-- Structured execution events: skill.started, skill.step.started, tool.called, permission.requested, ...
CREATE TABLE skill_execution_events (
  id           bigserial PRIMARY KEY,
  execution_id uuid NOT NULL REFERENCES skill_executions(id),
  seq          int NOT NULL,
  type         text NOT NULL,
  name         text,
  data         jsonb NOT NULL DEFAULT '{}',
  at           timestamptz NOT NULL,
  UNIQUE (execution_id, seq)
);

-- Actions requested by a skill step are tied to it; the step key makes the request idempotent
-- (a step re-run after a crash finds its action instead of proposing a second one).
ALTER TABLE actions ADD COLUMN skill_execution_id uuid REFERENCES skill_executions(id);
ALTER TABLE actions ADD COLUMN skill_step_key text;
CREATE UNIQUE INDEX actions_skill_step_key ON actions(skill_execution_id, skill_step_key) WHERE skill_execution_id IS NOT NULL;

-- The principal's own to-dos (no counterparty, unlike commitments). Deletion is soft: the row stays
-- for audit and the status says DELETED.
CREATE TABLE tasks (
  id                uuid PRIMARY KEY,
  principal_id      uuid NOT NULL REFERENCES principals(id),
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  notes             text,
  status            text NOT NULL CHECK (status IN ('OPEN', 'DONE', 'DELETED')),
  due_at            timestamptz,
  source            jsonb NOT NULL DEFAULT '{}', -- {executionId, evidence:[{kind,id}]}
  created_by        text NOT NULL CHECK (created_by IN ('PRINCIPAL', 'WENDY')),
  created_by_action uuid REFERENCES actions(id),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  completed_at      timestamptz,
  deleted_at        timestamptz
);
CREATE INDEX tasks_principal_status_idx ON tasks(principal_id, status);

-- Web pages and documents read by a skill, kept exactly as read so a claim can cite them.
CREATE TABLE captured_sources (
  id           uuid PRIMARY KEY,
  principal_id uuid NOT NULL REFERENCES principals(id),
  kind         text NOT NULL CHECK (kind IN ('web_page', 'document')),
  uri          text NOT NULL,
  title        text,
  content      text NOT NULL,
  content_hash text NOT NULL,
  bytes        int NOT NULL,
  execution_id uuid REFERENCES skill_executions(id),
  fetched_at   timestamptz NOT NULL,
  UNIQUE (principal_id, kind, uri, content_hash)
);
