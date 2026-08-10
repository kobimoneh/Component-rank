# Roadmap — what would make this a game changer

Four independent reviews of the shipped code, August 2026: a target user walking their real
part-selection workflow, a data-quality auditor, a product strategist, and a staff engineer
measuring behaviour at 500 / 5 000 / 50 000 components. Findings below are cited to
file and line, and the load-bearing ones were re-verified by hand.

They converged on one sentence.

> **The thesis is not wired up.** Gross solution size — the reason this app exists — is
> hardcoded `null` for every row in every table, and even if it were not, there is no
> mechanism by which it would ever be populated.

Everything in Tier 1 follows from that. Nothing in Tier 3 or 4 matters until it is fixed.

---

## The central finding

```ts
// src/db/repositories/components.ts:239
numeric['@gross_area'] = null // set once a solution profile exists
```

The column is declared at `components.ts:154` — *"Gross size", `better: 'lower'`* — and is
blank for every part, permanently. Gross size exists only in the drawer, one part at a
time, and in Compare, up to ten. **You can never see a list ranked by it.**

It is worse than a missing column. `src/import/config-yaml/import.ts:149` assigns
`@gross_area` as the **primary ranking rule** whenever the upstream metric prose says
"total solution" or "solution footprint". Four shipped categories do:
`buck-5v-3v3`, `buck-12v-3v3`, `wifi-transceiver`, `rf-lna-400mhz`. In exactly the
categories where the app's thesis applies, **every part is unranked**, with the reason
`"@gross_area is unknown."`

And `tests/integration.test.ts:110` asserts the blank, so the test suite holds the gap open.

Compounding it, on first launch **every seeded part in every category is unranked**:
`src/import/seed/seed.ts:76` writes every package `is_unverified = 1`, and
`src/domain/ranking/rank.ts:38` correctly refuses to rank unverified values. The correct
rule meets data that is 100% unverified, and the result is 36 tables of em dashes. The
README's screenshot is a state the user must hand-build, one drawer at a time.

---

# Tier 1 — make the thesis produce a number

## 1. Put gross solution size in the table

Join `solution_profile` / `external_part` in `listCategoryRows`, run the existing
`computeSolutionSize` per row, populate the cell and its `unverifiedFields`. Delete the
assertion that locks in the blank.

The machinery is built, tested and correct. It is connected to the drawer and not to the
thing the app is for. **~1–2 days, and it is the highest-value work in the repository.**

## 2. Make gross size populate itself — passive geometry + reference BOMs

Item 1 is worthless while the number stays empty in practice.

`estimate.ts:101` skips any external with a null dimension, and **there is no passive
geometry table anywhere in the repo** — `0402` appears only in a seed-parser regex and one
doc comment. So the user types the name, the package code, *and both dimensions*, looked up
from a Murata datasheet, for every passive. The nRF52840's recommended BOM is ~10 line
items: 50 hand-typed fields. Nobody does that 500 times, which is why gross size would stay
empty even after item 1.

The block is a good rule over-generalised. D10 says package codes must never become
dimensions — correct for ICs, where `(0403)` was a pin count. **Wrong for chip passives:**
an 0402 *is* 1.0 × 0.5 mm by EIA definition. The project applied an IC rule to passives and
blocked its own differentiator.

Two pieces:

- **A ~40-row standard geometry table** — 0201/0402/0603/0805, common inductor bodies,
  crystal packages. An external with a package code and no dimensions resolves
  automatically, marked `derived`, editable.
- **Per-category reference-BOM templates** — LDO = Cin + Cout; buck = L + Cin + Cout;
  BLE SoC = crystal + 2 load caps + balun + decoupling. Applied on creation, flagged
  `template`, one click from edited.

Together these change the tool from *"you can model solution size if you type everything"*
to *"solution size is the default axis"*. **~2–3 days.** Do it with item 1 or neither pays.

## 3. Let the user fix a number

`window.api.setPackage` **is never called anywhere in `src/renderer/`**. The Physical
section of the drawer is read-only `<dd>` elements. `setSpec` is called once, at creation
(`AddComponent.tsx:111`). **A part's dimensions and specs are write-once.** To correct a
typo you delete the part and re-enter it.

This interacts badly with the unverified seed: the only unblock is `confirmPackage`, which
is reachable from exactly one place (`Drawer.tsx:118`) and confirms *nominal* numbers
parsed from LLM prose — enshrining nominals in the app whose first rule is that maximum
dimensions win.

Editable drawer fields, plus multi-select "Confirm dimensions" in the row context menu.
IPC and repositories already exist and are tested; this is purely missing UI.
**~1–2 days.**

Free win alongside it: `src/import/seed/headline.ts:46` requires a trailing `mm`, so
`"5.5 mm² (2.45 x 2.25 WLCSP-47)"` parses as *no dimensions*. That is **17 of the 43
undimensioned parts** — 40% of the failures — for a regex change. **~1 hour.**

---

# Tier 2 — make the claims true

The trust architecture is the second-best thing in this codebase and its guarantees are
currently defeated one line at a time. These are cheap and they are the difference between
a documented principle and an actual one.

## 4. Close the four trust leaks

| Leak | Where | Effect |
|---|---|---|
| Compare tints on **display strings** | `compare.ts:167`, `numericOf` at `:234` | `0.5 mA` vs `500 µA` — identical currents — tint best and worst. A range shows its *min*; `≤ 25 nA` compares as an exact 25. The main table is correct, so the two screens disagree with no explanation. |
| `evidenceVerified` hardcoded | `apply.ts:134` | Every approved value is written `evidence_verified = 1` regardless of whether the quote was found. The guard at `mutations.ts:413` is dead code on this path. This single line turns the whole evidence mechanism into decoration. |
| `setPackage` clears unverified unconditionally | `mutations.ts:181` | Renaming a package `"DSBGA"` → `"DSBGA-4"` marks its untouched prose-parsed dimensions confirmed. The main laundering path for 107 seeded rows. |
| `covers` bypasses the unverified guard | `rank.ts:60`, and `compare.ts:156` hardcodes `unverified: false` | An unverified range satisfies a hard requirement and takes rank 1. Contradicts `COLOUR.md:43`. |

**Each is a few lines. Together, ~1 day.**

Two more worth fixing in the same pass, both proven by running the code:

- An **unverified** value is reported to the user as a *requirement failure*
  (`rank.ts:70`). A part drawing 4 mA is told it fails "under 6 mA" — because nobody has
  confirmed the number yet. That is a false accusation, not a missing value.
- Leader tiles have no minimum population (`leaders.ts:64`). With 107 of 150 parts
  unverified, *"best of 1, 47 excluded"* is the normal case, and it lives in a hover-only
  tooltip. Put the count on the face of the tile. **~1 hour, high leverage.**

## 5. Report the estimator honestly

The reviewer re-implemented `estimateRectangle` and ran real BOMs through it. Three results:

- **The packing is decorative.** Across every realistic case D lands within 0–10% of the
  closed form `1.15 × Σ(w + 0.5)(h + 0.5)`. The 64 candidate widths and the shelf pack
  contribute single-digit percent.
- **The rectangle is not a shape.** A 1.5 × 1.5 module with two 0603s reports
  **2.25 × 4.93 mm** — a 1:2.2 sliver, because `minWidth` is set by the widest single part
  (`estimate.ts:59`). `Compare.tsx:152` then *draws it to scale*.
- **The absolute number is hostage to one constant.** Sweeping `courtyardMarginMm`:
  0.10 → 3.10 mm², 0.25 → 5.43, 0.50 → 10.68. A **3.4× swing** on the headline figure.
  Note `GROSS_SIZE_MODEL.md:5` motivates the feature with *"perhaps 2.5 mm² of board"* for
  that exact part; the shipped estimator says 5.43. **The doc and the code disagree by 2×
  on the model's own worked example.**

But the ordering is robust — across all three margins, three candidate bucks stay in the
same order — and the model gets one thing genuinely right that a spreadsheet cannot:
**discrete part count is a first-class board cost.** A 5×5 IC with two 0603s beats a 2×2
with twenty 0402s on D and loses on C, which is correct.

So: **report D as a comparative index or a ± band, drop the fabricated width × height,
stop drawing the rectangle.** The docs half-know this (`D9`, `GROSS_SIZE_MODEL.md:29`) and
the UI then prints `5.20 × 4.40 mm` to two decimals — which *will* be quoted as a
measurement. Also note `GROSS_SIZE_MODEL.md:70` claims the `D > C` test guards the model;
`D > C` is guaranteed by construction, so it proves arithmetic, not reality. **~1 day.**

Worth 2–3 days more: a per-part routing allowance keyed off pin count and pitch. A 400-ball
BGA and a 4-pin LDO currently get the same flat ×1.15, and BGA escape routing is the
dominant board-area cost.

---

# Tier 3 — survive 500 parts

## 6. Parametric filter and global search

`docs/UX.md:80` specifies numeric range filters, facets, a missing-data filter, a column
picker and virtualization. **None is implemented.** The table is a plain `visible.map` with
header-click sorting. `@tanstack/react-table` and `react-virtual` are in `package.json` and
imported by nothing.

*"BLE SoCs under 4 mm², Vin covering 1.8 V, active"* — the app's own headline user story
(`PRODUCT_SPEC.md:35`) — cannot be asked. That is the most common action in the tool, and
it currently loses to a spreadsheet.

`searchComponents` is implemented, bridged in the preload, and **called from nothing**
(`components.ts:296`). The topbar box filters the current family only. Worse: a part
created with no family writes no `component_category` row (`mutations.ts:71`), and the rail
lists only categories — so **a part added with Family = "— none —" is permanently
invisible**.

**~4 h for a Ctrl-K global palette over the existing query, ~3–5 days for real filters.**
Virtualization becomes necessary at ~500 rows in one family (measured: 108 ms SSR at 500,
1 593 ms at 5 000, and every keystroke re-diffs all rows because the table JSX is inline
in `App`).

## 7. Batch ingestion, and a review queue that exists

Bulk ingestion is **write-only today**. There is no IPC channel and no UI for the review
queue: `proposed_value`, `listProposals` and `ingest_job` appear only in the repository,
the HTTP server and `apply.ts`. `MUTATION_CHANNELS` has no `proposals:list` and no
`proposal:accept`. `AI_INTEGRATION.md` draws `E --> G["Human review in the app"]`;
**that arrow does not exist in code.** 500 datasheets in gives 500 jobs at `status='proposed'`
and no way to turn any of them into a value.

The in-app path is structurally single-file: `DropZone.tsx:123` takes `files?.[0]`, and
`Review.tsx` is a modal for one outcome.

What is needed, without weakening the guarantee — `verifyClaim` is a pure function over
stored page text, it runs inside `submitProposal`, and it is genuinely unbypassable from
the API. Keep all of it:

1. **A review-queue screen.** `Review.tsx`'s `FieldRow` and `highlight()` are reusable.
2. **Batch review by parameter, not by field.** 500 datasheets × 6 parameters = 3 000
   decisions. Group across parts — *"47 parts propose `iq`, all verified, all from a
   mechanical table"* — so the human approves a class of evidence. Verification stays
   per-field; only the unit of attention changes. This is the only way 500 datasheets is
   not 3 000 clicks, and it costs the guarantee nothing.
3. **Something that drains the queue.** The model is called from the IPC path, not the job
   queue, so an agent posting to `/jobs` gets a row nothing processes.

**Review queue + batch review: L. Queue driver: M.** This is the single largest gap between
the stated goal and the code.

## 8. Stop the three crashes and the data-loss path

Measured, not predicted:

- **Backup destroys itself at ~30 stored datasheets.** `export.ts:45` does `SELECT *` on
  `datasheet`, pulling every PDF blob, then `ipc.ts:313` runs `JSON.stringify`. A
  `Uint8Array` stringifies at **9.5 chars per byte**. With 200 × 2 MB datasheets:
  *throws `Invalid string length` after 34.7 s*. The cliff is ~54 MB of PDFs — **25–50 real
  datasheets, so it breaks before 500 components, not after.** It works today only because
  every seeded row has `content = NULL`. Also `checkBackup` has no caller outside tests:
  **there is no restore path.**
- **The second variant steals the datasheet.** `datasheet.component_id` is a single column;
  `apply.ts:115` re-points it unconditionally. Ingest a family PDF for a second ordering
  code and the first part silently loses its datasheet. Guaranteed at bulk scale, and family
  datasheets are the norm. Needs a `component_datasheet` join table.
- **No `busy_timeout` and no single-instance lock.** A second writer gets an immediate
  `database is locked`; two copies of the app open the same file. Two lines.
- `window-all-closed` closes the DB, then `app.quit()` fires `before-quit`, which closes it
  again → `ERR_INVALID_STATE` on every normal quit (`main/index.ts:332`, `:339`).

**Items 1–4 here are a single afternoon and remove two crashes and one data-loss path.**

Also, quietly: `component_fts` is created with a comment promising *"kept in sync by
triggers"* — **there are no triggers**, and nothing reads or writes it. Real search is five
`LIKE '%q%'` predicates.

---

# Tier 4 — the 10x

## 9. Buildability: pitch, layers, escape routing, land-pattern courtyard

"Smallest" is already available at Digi-Key. **"Smallest I can actually route on two layers
with 4 mil rules" is available nowhere**, and it is the app's own stated headline question
(`PRODUCT_SPEC.md:34`) — which the schema cannot currently represent. `CREATE TABLE package`
has `pin_count` and nine dimension cells: **no pitch, no ball array, no layer count, no
design rules.**

Add pitch / ball array / thermal pad, plus a fab profile (min trace-space, via type, layer
count). Compute escape routability, layers required, and the **IPC-7351 land-pattern
courtyard** instead of the package body — which is also a correctness fix, because board
cost is the courtyard, not the body max.

This is the one proposal a competitor cannot copy by scraping: it is rules plus judgement,
not catalogue data. It also converts the existing size machinery from decorative to
load-bearing. Fold in **Z-height as a ranked field** — already stored, never ranked.

## 10. Global parameter identity — and do it before 100 families

*"Every part under 1 mm², regardless of category"* is **not possible today.** There is no
persisted area (`@ic_area` is computed in JS at read time), and the only parametric read is
category-scoped by construction.

Deeper: `spec_def` is per-category with `UNIQUE(category_id, key)`, and keys come from
display names. "Quiescent current" is `iq` in one family and `quiescent_current` in
another; `createFamily(copyParametersFrom)` duplicates the rows outright. Today: 212
spec_defs over 36 categories. At 300 categories, ~1 800 definitions with **no global
identity**. The only key that survives across families is `dimension` — so the query you
can write is "any current-dimension spec under X", which nobody asks.

A `parameter` table + `spec_def` as a per-category *binding* + a backfill migration.
**This is the most expensive-to-reverse decision in the schema, and it gets more expensive
with every family created.**

Cheap interim that answers the actual question: a persisted, indexed `package.area_mm2`
plus `GET /components?areaMax=`. Measured at 0.03 ms over the real seed. **~half a day.**

---

# What to stop doing

Named because each represents real effort already spent, and more is planned:

- **The local HTTP API surface.** 338 lines, 304 lines of tests, and the project's longest
  document (408 lines) — for a client that does not exist, duplicating an in-app path that
  already carries two near-identical 150-line functions destined to drift. Freeze it until
  item 7 gives it a consumer.
- **Taxonomy, sections and context menus.** `taxonomy.ts` + `mutations.ts` + `ContextMenu`
  + `Dialogs` + two test files + a migration + three decision records — the largest single
  body of code in the app, managing *furniture* for a 36-row sidebar with one user. It is
  correct and it is orthogonal to whether the tool answers an engineering question.
- **Non-destructive sync machinery** protecting against an upstream repo the same person
  maintains and publishes monthly.
- **Packaging polish, colour-contrast test suites, multi-display window plumbing.** All
  well done. All finished. Every hour there is an hour not spent making the size number
  true.

# What is genuinely good and should not be touched

- **Maximum-dimension discipline with per-axis basis reporting** (`domain/physical/package.ts`).
  Nobody else does this, and on a 0.4 mm-pitch part it is the difference between a keepout
  that works and one that does not.
- **Unknown is not zero; unverified does not rank** (`rank.ts:38`, `:125`). The single most
  common way a parts spreadsheet lies to you, made structurally impossible.
- **Hard requirements exclude but do not hide** (`rank.ts:117`). Rows that vanish silently
  are how you lose trust in a table.
- **Ties are reported, not broken** — 1, 2, 2, 4.
- **The evidence verifier as a pure function** over stored page text, unbypassable from the
  API. *"The strongest thing in this codebase"* — provided item 4 stops the apply path from
  overwriting its verdict.

---

# Order of work

| | Item | Size |
|---|---|---|
| 1 | Gross size in the table (#1) | 1–2 d |
| 2 | Passive geometry + reference BOMs (#2) | 2–3 d |
| 3 | The four trust leaks + leader population count (#4) | 1 d |
| 4 | The afternoon of crash fixes (#8, items 1–4) | 0.5 d |
| 5 | Editable dimensions and specs + bulk confirm + the seed regex (#3) | 2 d |
| 6 | Report D as an index; stop drawing the rectangle (#5) | 1 d |
| 7 | Global search (4 h), then parametric filters (#6) | 4 d |
| 8 | Review queue + batch-by-parameter approval (#7) | L |
| 9 | Buildability model (#9) | L |
| 10 | Global parameter identity (#10) | L |

Items 1–6 are about **two weeks** and take the app from *a beautiful table of em dashes*
to *the only tool that ranks parts by what they actually cost you in board area*. That is
the game changer. Items 9 and 10 are what make it defensible afterwards.
