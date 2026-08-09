-- =============================================================================
-- 004 — "Where used?" and extraction bookkeeping
-- =============================================================================
-- `where_used` is a free-text field you fill in by hand: which of your boards,
-- projects or revisions this part actually ships on. It is deliberately not a
-- structured relation to a "projects" table — the value is in writing
-- "Sensor node rev C, replaced the AP7350" quickly, and a schema would get in
-- the way of that.
--
-- It participates in search, because "what did I use on the sensor node?" is a
-- question worth being able to ask.
-- =============================================================================

ALTER TABLE component ADD COLUMN where_used TEXT NOT NULL DEFAULT '';

-- Which model produced a proposal, so a review can weigh it and a bad model can
-- be identified after the fact.
ALTER TABLE ingest_job ADD COLUMN provider TEXT;
ALTER TABLE ingest_job ADD COLUMN model TEXT;

-- Identity the extractor believes it found, held on the job until the component
-- is created. Kept separate from `component` because nothing is created until
-- the review is accepted.
ALTER TABLE ingest_job ADD COLUMN detected_json TEXT;
