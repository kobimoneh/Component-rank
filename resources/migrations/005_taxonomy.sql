-- =============================================================================
-- 005 — sections, and a taxonomy you can rearrange
-- =============================================================================
-- The left rail groups families (categories) under a heading taken from
-- `category.group_name`, a bare string that arrived with the component-report
-- import. That is fine for reading and useless for editing: there is nothing to
-- rename, nothing to reorder, and the display order lived in a hard-coded array
-- in the renderer.
--
-- A section is now a row. It has a name you can change, an order you can change,
-- and an identity that survives both. Families point at it.
--
-- `group_name` is deliberately kept. It records what UPSTREAM says the grouping
-- is, and stays the source for placing newly imported families. `section_id` is
-- where the family actually sits in your rail. They agree until you move
-- something, and `section_pinned` records that you did — after which a re-sync
-- leaves the placement alone. Same contract as everywhere else here: your edit
-- wins, and the import says so rather than silently reasserting itself.
-- =============================================================================

CREATE TABLE section (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  -- Case-insensitive uniqueness: "RF PA" and "RF pa" are the same section, and
  -- letting both exist would split a rail heading in two.
  name_norm  TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ''
);

ALTER TABLE category ADD COLUMN section_id INTEGER REFERENCES section(id) ON DELETE SET NULL;

-- Set once you have placed this family yourself. Sync then stops moving it, but
-- keeps updating everything else about the family.
ALTER TABLE category ADD COLUMN section_pinned INTEGER NOT NULL DEFAULT 0;

-- A family you delete must not reappear on the next re-sync. Without this the
-- import would put it straight back, which is the same silent undo that
-- `category_removed_spec` exists to prevent for parameters.
CREATE TABLE deleted_category (
  slug       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

-- Adopt the group names already in use as the first sections.
--
-- Order them by where their first family appears in the import, which is the
-- order component-report itself uses — and, importantly, the same order the
-- sync path produces when it creates sections one at a time on a fresh
-- database. One rule for both, so the rail does not depend on whether you
-- installed before or after this migration. From here it is yours to change.
INSERT INTO section (name, name_norm, sort_order, created_at)
SELECT group_name, lower(group_name), (MIN(sort_order) + 1) * 10, ''
FROM category
GROUP BY lower(group_name), group_name;

UPDATE category
SET section_id = (SELECT s.id FROM section s WHERE s.name_norm = lower(category.group_name));

CREATE INDEX idx_category_section ON category(section_id);
