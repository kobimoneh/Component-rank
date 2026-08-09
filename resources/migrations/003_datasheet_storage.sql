-- =============================================================================
-- 003 — datasheets in the database, and an ingestion queue
-- =============================================================================
-- The database must stay portable: one file you can copy to another machine and
-- still have everything. A datasheet referenced by an absolute path breaks that
-- the moment the file moves, so the PDF bytes live in the database alongside the
-- extracted page text.
--
-- Page text is stored because evidence verification needs it. Without the text
-- an extracted value cannot be checked against the page it cites, and the whole
-- anti-hallucination mechanism becomes a promise again.
-- =============================================================================

ALTER TABLE datasheet ADD COLUMN content BLOB;
ALTER TABLE datasheet ADD COLUMN byte_size INTEGER;
ALTER TABLE datasheet ADD COLUMN mime TEXT NOT NULL DEFAULT 'application/pdf';
ALTER TABLE datasheet ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE datasheet ADD COLUMN text_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE datasheet ADD COLUMN ocr_engine TEXT;
ALTER TABLE datasheet ADD COLUMN ingested_at TEXT;

CREATE INDEX idx_datasheet_sha ON datasheet(sha256);

-- One row per page. `method` records how the text was obtained, because a page
-- read by OCR is less trustworthy than one with a real text layer, and the
-- review screen should be able to say so.
CREATE TABLE datasheet_page (
  id           INTEGER PRIMARY KEY,
  datasheet_id INTEGER NOT NULL REFERENCES datasheet(id) ON DELETE CASCADE,
  page         INTEGER NOT NULL,
  text         TEXT NOT NULL DEFAULT '',
  method       TEXT NOT NULL DEFAULT 'text-layer'
               CHECK (method IN ('text-layer', 'ocr', 'vision', 'none')),
  confidence   REAL,
  UNIQUE (datasheet_id, page)
);

CREATE INDEX idx_datasheet_page ON datasheet_page(datasheet_id, page);

-- Full-text search across datasheet pages, so an agent can find the page that
-- mentions a parameter before extracting it.
CREATE VIRTUAL TABLE datasheet_page_fts USING fts5(
  text,
  content = 'datasheet_page',
  content_rowid = 'id',
  tokenize = "unicode61 tokenchars '-_.'"
);

CREATE TRIGGER datasheet_page_ai AFTER INSERT ON datasheet_page BEGIN
  INSERT INTO datasheet_page_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER datasheet_page_ad AFTER DELETE ON datasheet_page BEGIN
  INSERT INTO datasheet_page_fts(datasheet_page_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER datasheet_page_au AFTER UPDATE ON datasheet_page BEGIN
  INSERT INTO datasheet_page_fts(datasheet_page_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO datasheet_page_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Work queue. An offline agent claims a job, does the reading, and posts a
-- proposal back; nothing it produces is applied without review.
CREATE TABLE ingest_job (
  id            INTEGER PRIMARY KEY,
  datasheet_id  INTEGER REFERENCES datasheet(id) ON DELETE CASCADE,
  component_id  INTEGER REFERENCES component(id) ON DELETE SET NULL,
  mpn_hint      TEXT,
  category_hint TEXT,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','claimed','proposed','applied','rejected','failed')),
  claimed_by    TEXT,
  claimed_at    TEXT,
  proposal_json TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX idx_ingest_status ON ingest_job(status, id);

-- A proposal a human has not yet accepted. Kept separate from spec_value so
-- nothing an agent produces can be mistaken for confirmed data.
CREATE TABLE proposed_value (
  id           INTEGER PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES ingest_job(id) ON DELETE CASCADE,
  component_id INTEGER REFERENCES component(id) ON DELETE CASCADE,
  target       TEXT NOT NULL CHECK (target IN ('spec','package','identity','external')),
  spec_key     TEXT,
  raw_value    TEXT,
  unit         TEXT,
  page         INTEGER,
  evidence     TEXT,
  evidence_verified INTEGER NOT NULL DEFAULT 0,
  confidence   REAL,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','accepted','rejected','superseded')),
  conflict     TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX idx_proposed_job ON proposed_value(job_id, status);
