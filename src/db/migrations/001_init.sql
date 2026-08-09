-- =============================================================================
-- 001 — initial schema
-- =============================================================================
-- Hybrid model (spec section 21): universal fields are normalized columns, and
-- category-specific specifications live in spec_value with TYPED columns — not a
-- JSON blob, and not dozens of nullable columns on `component`.
--
-- Filtering, sorting and ranking read num_min / num_typ / num_max only. A
-- formatted string is never the source of truth for a number.
-- =============================================================================

CREATE TABLE manufacturer (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  name_norm  TEXT NOT NULL UNIQUE,
  url        TEXT
);

CREATE TABLE category (
  id                 INTEGER PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  group_name         TEXT NOT NULL DEFAULT 'Other',
  description        TEXT NOT NULL DEFAULT '',
  metric_prose       TEXT NOT NULL DEFAULT '',
  ranking_unresolved INTEGER NOT NULL DEFAULT 0,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  -- 'imported' rows come from component-report and may be re-synced.
  -- 'local' rows were created here and are never touched by a sync.
  source             TEXT NOT NULL DEFAULT 'imported' CHECK (source IN ('imported','local')),
  -- Hash of the upstream text this row was built from. Sync compares against it
  -- to tell "unchanged upstream" from "you edited this".
  source_hash        TEXT,
  locally_modified   INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE category_manufacturer (
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category_id, name)
);

-- best_in_class from component-report: reference NAMES only. No specification is
-- ever imported for these, because upstream carries none that was verified.
CREATE TABLE category_reference_part (
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  mpn         TEXT NOT NULL,
  ord         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category_id, mpn)
);

CREATE TABLE category_note (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  note        TEXT NOT NULL
);

CREATE TABLE spec_def (
  id               INTEGER PRIMARY KEY,
  category_id      INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  key              TEXT NOT NULL,
  name             TEXT NOT NULL,
  type             TEXT NOT NULL CHECK (type IN ('scalar','range','number','bool','enum','text')),
  dimension        TEXT,
  unit             TEXT,
  unit_label       TEXT,
  better           TEXT NOT NULL DEFAULT 'none' CHECK (better IN ('lower','higher','none')),
  enum_values      TEXT,
  table_visible    INTEGER NOT NULL DEFAULT 0,
  col_order        INTEGER NOT NULL DEFAULT 0,
  filterable       INTEGER NOT NULL DEFAULT 1,
  sortable         INTEGER NOT NULL DEFAULT 1,
  ai_hint          TEXT,
  -- The importer could not type this parameter; it shows in "needs typing".
  unmapped         INTEGER NOT NULL DEFAULT 0,
  source_phrase    TEXT,
  source           TEXT NOT NULL DEFAULT 'imported' CHECK (source IN ('imported','local')),
  locally_modified INTEGER NOT NULL DEFAULT 0,
  UNIQUE (category_id, key)
);

CREATE TABLE ranking_rule (
  id             INTEGER PRIMARY KEY,
  category_id    INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  ord            INTEGER NOT NULL,
  field          TEXT NOT NULL,
  direction      TEXT NOT NULL CHECK (direction IN ('asc','desc')),
  missing_policy TEXT NOT NULL DEFAULT 'last' CHECK (missing_policy IN ('last','first','exclude'))
);

CREATE TABLE ranking_requirement (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  op          TEXT NOT NULL CHECK (op IN ('<','<=','>','>=','=','covers')),
  value       REAL NOT NULL,
  unit        TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE component (
  id              INTEGER PRIMARY KEY,
  manufacturer_id INTEGER NOT NULL REFERENCES manufacturer(id),
  mpn             TEXT NOT NULL,
  -- Case- and separator-insensitive form used for duplicate detection.
  mpn_norm        TEXT NOT NULL,
  family          TEXT,
  category_id     INTEGER REFERENCES category(id) ON DELETE SET NULL,
  lifecycle       TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (lifecycle IN ('active','nrnd','eol','obsolete','unknown')),
  product_url     TEXT,
  price_1k_usd    REAL,
  notes           TEXT NOT NULL DEFAULT '',
  favorite        INTEGER NOT NULL DEFAULT 0,
  flag            TEXT CHECK (flag IN ('reference','best_in_class','avoid') OR flag IS NULL),
  origin          TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual','imported','extracted')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (manufacturer_id, mpn_norm)
);

CREATE INDEX idx_component_category ON component(category_id);
CREATE INDEX idx_component_mpn_norm ON component(mpn_norm);

CREATE TABLE component_tag (
  component_id INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  tag          TEXT NOT NULL,
  PRIMARY KEY (component_id, tag)
);

-- Physical package for the EXACT ordering part number. A family in QFN, BGA and
-- WLCSP is three components, not one with three sizes.
CREATE TABLE package (
  id                INTEGER PRIMARY KEY,
  component_id      INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  type              TEXT,
  name              TEXT,
  pin_count         INTEGER,
  x_min REAL, x_nom REAL, x_max REAL,
  y_min REAL, y_nom REAL, y_max REAL,
  z_min REAL, z_nom REAL, z_max REAL,
  origin            TEXT NOT NULL DEFAULT 'manual'
                    CHECK (origin IN ('manual','imported','extracted','derived')),
  -- Dimensions that have not been confirmed against a datasheet. Excluded from
  -- ranking until confirmed; rendered greyed and dashed in the UI.
  is_unverified     INTEGER NOT NULL DEFAULT 0,
  unverified_reason TEXT,
  UNIQUE (component_id)
);

CREATE TABLE spec_value (
  id            INTEGER PRIMARY KEY,
  component_id  INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  spec_def_id   INTEGER NOT NULL REFERENCES spec_def(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('scalar','range','number','bool','enum','text')),
  -- Canonical values for the spec's dimension. Comparison reads only these.
  num_min       REAL,
  num_typ       REAL,
  num_max       REAL,
  canonical_unit TEXT,
  display_unit  TEXT,
  bool_val      INTEGER,
  text_val      TEXT,
  enum_val      TEXT,
  origin        TEXT NOT NULL DEFAULT 'manual'
                CHECK (origin IN ('manual','imported','extracted','derived')),
  is_unverified INTEGER NOT NULL DEFAULT 0,
  confidence    REAL,
  updated_at    TEXT NOT NULL,
  UNIQUE (component_id, spec_def_id)
);

CREATE INDEX idx_spec_value_def ON spec_value(spec_def_id);
CREATE INDEX idx_spec_value_num ON spec_value(spec_def_id, num_typ);

CREATE TABLE datasheet (
  id           INTEGER PRIMARY KEY,
  component_id INTEGER REFERENCES component(id) ON DELETE CASCADE,
  file_path    TEXT,
  sha256       TEXT,
  url          TEXT,
  title        TEXT,
  revision     TEXT,
  page_count   INTEGER,
  added_at     TEXT NOT NULL
);

-- Where an extracted value came from, so any number can be traced to a page.
CREATE TABLE provenance (
  id                INTEGER PRIMARY KEY,
  subject_type      TEXT NOT NULL CHECK (subject_type IN ('spec_value','package','component')),
  subject_id        INTEGER NOT NULL,
  datasheet_id      INTEGER REFERENCES datasheet(id) ON DELETE SET NULL,
  page              INTEGER,
  evidence          TEXT,
  -- True only when the evidence quote was found verbatim in the page text.
  -- A model claim that fails this check is never stored as confirmed.
  evidence_verified INTEGER NOT NULL DEFAULT 0,
  confidence        REAL,
  model             TEXT,
  extracted_at      TEXT NOT NULL
);

CREATE INDEX idx_provenance_subject ON provenance(subject_type, subject_id);

CREATE TABLE solution_profile (
  id            INTEGER PRIMARY KEY,
  component_id  INTEGER NOT NULL REFERENCES component(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  is_default    INTEGER NOT NULL DEFAULT 0,
  notes         TEXT,
  override_w    REAL,
  override_h    REAL,
  override_area REAL,
  override_note TEXT,
  ord           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (component_id, name)
);

CREATE TABLE external_part (
  id           INTEGER PRIMARY KEY,
  profile_id   INTEGER NOT NULL REFERENCES solution_profile(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  function     TEXT NOT NULL DEFAULT '',
  qty          INTEGER NOT NULL DEFAULT 1,
  necessity    TEXT NOT NULL DEFAULT 'required'
               CHECK (necessity IN ('required','recommended','optional','configuration')),
  value_text   TEXT,
  package_name TEXT,
  x_mm REAL, y_mm REAL, z_mm REAL,
  included     INTEGER NOT NULL DEFAULT 1,
  notes        TEXT,
  source_ref   TEXT,
  ord          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_external_profile ON external_part(profile_id);

CREATE TABLE extraction_job (
  id            INTEGER PRIMARY KEY,
  component_id  INTEGER REFERENCES component(id) ON DELETE SET NULL,
  datasheet_id  INTEGER REFERENCES datasheet(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL,
  model         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','review','saved','failed','cancelled')),
  request_json  TEXT,
  response_json TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE recently_viewed (
  component_id INTEGER PRIMARY KEY REFERENCES component(id) ON DELETE CASCADE,
  viewed_at    TEXT NOT NULL
);

-- Full-text search over identity and notes. Kept in sync by triggers so a
-- forgotten call site cannot leave the index stale.
CREATE VIRTUAL TABLE component_fts USING fts5(
  mpn, family, manufacturer, notes, tags,
  content = '',
  tokenize = "unicode61 tokenchars '-_.'"
);
