# Product Specification

## The one-line goal

> "I want all the main components I use to be logged by basic parameters — ranked in some
> sort of table — where size is the main deal."

## What it is

A local desktop database for the components you actually use, optimized for selection and
comparison inside meaningful engineering categories, where **physical size — both the IC
and the real PCB solution — is the primary axis**.

A tool to keep open beside Altium or KiCad while choosing parts for a new board.

## What it is not

- Not an inventory or stock system
- Not a BOM manager
- Not a distributor front-end (live pricing and availability are explicitly out of scope
  for V1; the schema leaves room for them later)
- Not a generic database with one component shape — an LDO and an MCU do not show the same
  columns, and the UI understands the difference

---

## Users and use

One user: an embedded hardware engineer selecting parts. Offline, local, private. The
database is a file you own and can copy, back up, or read with any SQLite browser.

Typical sessions:

1. *"What is the smallest BLE SoC I can lay out on 2 layers?"* — open the category, sort by
   IC area, filter on 2-layer feasibility, compare the top four.
2. *"This LDO is tiny, but what does it actually cost me?"* — open it, read gross size,
   toggle whether you really need the output cap you were told to fit.
3. *"I have a new datasheet."* — drop the PDF, review what was extracted, save.
4. *"Which of these three is smallest once everything is placed?"* — select, compare,
   switch the size visualization from package to gross.

---

## Core principles

1. **Size is first-class.** Every component stores X/Y/Z with min/nominal/max where the
   datasheet gives them. Area comparisons use **maximum** dimensions.
2. **Package size is not solution size.** They are separate numbers and are never conflated.
3. **Categories carry their own meaning.** Columns, ranking and filters come from the
   category definition, which is data and editable.
4. **Trustworthy data.** Every AI-derived value is traceable to a page and a quote. Values
   that cannot be verified are marked, not quietly accepted.
5. **Manual always wins.** Your corrections are never overwritten without approval.
6. **No hallucination.** A value not found is `Unknown`. Never invented.
7. **Fast without AI.** Browsing, filtering, sorting and comparing never call a model.

---

## Category taxonomy

Imported from [`kobimoneh/component-report`](https://github.com/kobimoneh/component-report)
so the two stay in step: **36 categories**, grouped for navigation.

| Group | Count | Examples |
|---|---|---|
| Power | 4 | Tiny LDO, buck 5V→3V3, buck 12V→3V3, load switch / power mux |
| Wireless | 3 | BLE transceiver, Wi-Fi transceiver, UWB transceiver |
| MCU | 4 | Smallest MCU, smallest Zephyr MCU, BLE MCU (easy layout), BLE MCU (high performance) |
| FPGA | 4 | Low / mid / high capacity, hardened PCIe |
| RF | 17 | PA, LNA, filter, switch across 2.4 GHz / sub-GHz / cellular / 5–6 GHz, plus 400 MHz low-power LNA |
| Memory | 2 | 128 Mbit SPI NOR, 128 Mbit any type |
| Connectors | 1 | Ultra-small B2B / B2C |
| Interface | 1 | Smallest PCIe PHY |

The brief also names cellular, GNSS, Wi-Fi HaLow, MEMS microphone, sensors, generic memory
and MCU-without-RF. Upstream does not define these yet — which is precisely why **adding a
category must never require a code change**. See
[CATEGORY_SCHEMA.md](CATEGORY_SCHEMA.md).

---

## Seed data

The June 2026 report contains **160 real parts** across all 36 categories with MPN,
manufacturer, datasheet URL and 1 k price. These are imported as real components.

Their prose size descriptions (`"0.41 mm^2 (0.64x0.64 mm DSBGA)"`) are LLM-written and
unverified, so:

- Explicit `W × H mm` pairs are parsed into a package marked `imported`, `is_unverified` —
  greyed, dashed, and **excluded from ranking** until confirmed
- Package codes are **never** used to infer dimensions. (`"0.99 mm² (0403)"` in the real
  data does not match the imperial 0403 size — inference here would manufacture a wrong
  number.)
- Unparseable text is kept verbatim as a note, not as a number

`best_in_class` entries import as reference **names** only. No specification is ever
fabricated for them.

---

## V1 acceptance criteria

From the brief. Current status:

| # | Criterion | Status |
|---|---|---|
| 1 | Categories imported from `component-report` | ✅ 36, tested |
| 2–4 | Add an MCU / LDO / memory device manually | 🔨 Phase 2 |
| 5 | Store exact X × Y × Z dimensions | ✅ Model + tests |
| 6 | Define required external components | ✅ Model + tests |
| 7 | See IC area | ✅ |
| 8 | See gross solution area | ✅ |
| 9 | Change externals, gross size recalculates immediately | ✅ Model + tests |
| 10 | Multiple solution profiles | ✅ Model |
| 11 | Browse components by category | 🔨 Phase 2 |
| 12 | Sort and filter by category characteristics | 🔨 Phase 2 |
| 13 | See a rank inside a category | 🔨 Phase 3 |
| 14 | Compare side by side | 🔨 Phase 3 |
| 15 | Scaled visual package-size comparison | 🔨 Phase 3 |
| 16–19 | Datasheet upload, AI suggestion, review, evidence | ⏳ Phase 5 |
| 20 | Export / back up | ⏳ Phase 4 |

---

## Phasing

| Phase | Contents | State |
|---|---|---|
| 1 | Docs, shell, SQLite, migrations, category model, importer | ✅ except shell |
| 2 | Component CRUD, category tables, search, filter, sort | 🔨 |
| 3 | Ranking, comparison, units, ranges, size visualization | ⏳ |
| 4 | Solution profiles, externals, gross size, override, export | ⏳ domain done, UI pending |
| 5 | Datasheet ingestion, AI extraction, review, provenance | ⏳ interfaces stubbed |
| 6 | Backup, favourites, notes, data quality, shortcuts, packaging | ⏳ |

A solid V1 is preferred over a broad set of unfinished features. Phases 1–4 are the
committed V1 scope; 5 is additive against interfaces built now.

---

## Non-goals for V1

- Live distributor stock and pricing
- Multi-user, sync, or any cloud service
- Schematic or layout integration
- Automatic web search for parts (that is what `component-report` does)
