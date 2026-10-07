-- Phase 2 (3.3, deterministic part): commitments with the principal in the loop.
-- PROPOSED (extracted from a message, awaiting the principal) → OPEN (confirmed) → DONE | CANCELLED.
-- A proposed commitment must carry the literal quote from its source message.
ALTER TABLE commitments DROP CONSTRAINT commitments_status_check;
ALTER TABLE commitments ADD CONSTRAINT commitments_status_check CHECK (status IN ('PROPOSED', 'OPEN', 'DONE', 'CANCELLED'));
ALTER TABLE commitments ADD COLUMN source_quote text;
ALTER TABLE commitments ADD COLUMN status_changed_at timestamptz;
ALTER TABLE commitments ADD COLUMN status_reason text;
ALTER TABLE commitments ADD CONSTRAINT commitments_proposed_quote_check
  CHECK (status <> 'PROPOSED' OR (source_message_id IS NOT NULL AND source_quote IS NOT NULL AND length(source_quote) > 0));
