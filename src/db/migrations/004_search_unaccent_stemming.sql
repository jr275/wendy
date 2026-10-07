-- Search that ignores accents and reduces words to their stem, in Portuguese and English.
-- Each record is indexed with four configurations; queries try all four (see repositories/pg.ts):
--   wendy_pt_stem  Portuguese stems on the accented text   ("renovações" and "renovação" → renov)
--   wendy_pt       accents removed, then Portuguese stems   ("reuniao" and "Reunião" → reunia)
--   wendy_en       accents removed, then English stems      ("discounts" → discount)
--   wendy_simple   accents removed, no stemming             (names, codes, mixed tokens)
-- Both Portuguese forms are needed: the Snowball stemmer expects accents (-ção/-ções), while
-- people often type without them.

-- The extension is database-wide; it lives in "public" so every schema (dev and test) can use it.
-- Parallel migrations (test schemas) may race on creation: losing the race is fine.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public;
EXCEPTION WHEN unique_violation OR duplicate_object THEN NULL;
END $$;

CREATE TEXT SEARCH CONFIGURATION wendy_pt_stem (COPY = pg_catalog.portuguese);
CREATE TEXT SEARCH CONFIGURATION wendy_pt (COPY = pg_catalog.portuguese);
ALTER TEXT SEARCH CONFIGURATION wendy_pt ALTER MAPPING FOR hword, hword_part, word WITH public.unaccent, portuguese_stem;
CREATE TEXT SEARCH CONFIGURATION wendy_en (COPY = pg_catalog.english);
ALTER TEXT SEARCH CONFIGURATION wendy_en ALTER MAPPING FOR hword, hword_part, word WITH public.unaccent, english_stem;
CREATE TEXT SEARCH CONFIGURATION wendy_simple (COPY = pg_catalog.simple);
ALTER TEXT SEARCH CONFIGURATION wendy_simple ALTER MAPPING FOR hword, hword_part, word WITH public.unaccent, simple;

ALTER TABLE messages DROP COLUMN search;
ALTER TABLE messages ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('wendy_pt_stem', coalesce(subject, '') || ' ' || coalesce(body, '')) ||
  to_tsvector('wendy_pt', coalesce(subject, '') || ' ' || coalesce(body, '')) ||
  to_tsvector('wendy_en', coalesce(subject, '') || ' ' || coalesce(body, '')) ||
  to_tsvector('wendy_simple', coalesce(subject, '') || ' ' || coalesce(body, ''))) STORED;
CREATE INDEX messages_search_idx ON messages USING gin(search);

ALTER TABLE meetings DROP COLUMN search;
ALTER TABLE meetings ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('wendy_pt_stem', coalesce(title, '') || ' ' || coalesce(description, '')) ||
  to_tsvector('wendy_pt', coalesce(title, '') || ' ' || coalesce(description, '')) ||
  to_tsvector('wendy_en', coalesce(title, '') || ' ' || coalesce(description, '')) ||
  to_tsvector('wendy_simple', coalesce(title, '') || ' ' || coalesce(description, ''))) STORED;
CREATE INDEX meetings_search_idx ON meetings USING gin(search);

ALTER TABLE commitments DROP COLUMN search;
ALTER TABLE commitments ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('wendy_pt_stem', coalesce(description, '')) ||
  to_tsvector('wendy_pt', coalesce(description, '')) ||
  to_tsvector('wendy_en', coalesce(description, '')) ||
  to_tsvector('wendy_simple', coalesce(description, ''))) STORED;
CREATE INDEX commitments_search_idx ON commitments USING gin(search);

ALTER TABLE memories DROP COLUMN search;
ALTER TABLE memories ADD COLUMN search tsvector GENERATED ALWAYS AS (
  to_tsvector('wendy_pt_stem', content) ||
  to_tsvector('wendy_pt', content) ||
  to_tsvector('wendy_en', content) ||
  to_tsvector('wendy_simple', content)) STORED;
CREATE INDEX memories_search_idx ON memories USING gin(search);
