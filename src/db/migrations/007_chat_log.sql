-- The conversation with Wendy is kept, so it survives page reloads and restarts. One continuous
-- thread per principal (Wendy is one persistent assistant). Messages are stored in the AG-UI shape
-- the chat renders; tool messages carry the cards (answers, sites, skill runs). Additive only.
CREATE TABLE chat_messages (
  id           text NOT NULL,
  principal_id uuid NOT NULL REFERENCES principals(id),
  thread_id    text NOT NULL,
  seq          bigserial,
  role         text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  content      text,
  tool_calls   jsonb,
  tool_call_id text,
  created_at   timestamptz NOT NULL,
  PRIMARY KEY (principal_id, id)
);
CREATE INDEX chat_messages_thread_idx ON chat_messages(principal_id, thread_id, seq);
