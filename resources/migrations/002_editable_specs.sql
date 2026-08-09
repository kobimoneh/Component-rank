-- =============================================================================
-- 002 — user-editable category parameters
-- =============================================================================
-- Removing an imported parameter has to survive a re-sync. Without a record of
-- the removal, the next import would simply put it back, and the app would
-- silently undo a deliberate decision.
--
-- Adding a parameter needs no new table: a locally created spec_def already
-- carries source = 'local', which sync leaves alone.
-- =============================================================================

CREATE TABLE category_removed_spec (
  category_id INTEGER NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  removed_at  TEXT NOT NULL,
  PRIMARY KEY (category_id, key)
);
