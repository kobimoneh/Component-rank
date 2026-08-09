# UX

Professional engineering software. Think KiCad panels, Altium, DigiKey's parametric search
and a good IDE — but cleaner. Not a marketing site, not a dashboard.

**Data density beats decoration.** Every pixel of chrome is a row you cannot see.

---

## Layout

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Component Library          [ ⌕ Search…  ⌘K ]        + Add   ◐ Theme     │
├───────────────┬──────────────────────────────────────────────────────────┤
│ All (160)     │  Very small LDO regulator                                │
│               │  Smallest package footprint; then lowest Iq              │
│ POWER         │  ┌────────────────────────────────────────────────────┐  │
│  Tiny LDO  5  │  │ Rank MPN        Mfr   IC size  Gross   Vin    Iq  …│  │
│  Buck 5V   4  │  ├────────────────────────────────────────────────────┤  │
│  Buck 12V  4  │  │ #1  TPS7A0233…  TI    0.41     2.48   1.5–6.0  25n │  │
│  Load sw   5  │  │ #2  AP7350-33…  Diodes 0.41    2.48   1.7–5.5 250n │  │
│ WIRELESS      │  │ #3  NCP163AMX…  onsemi 0.49    2.56   1.9–5.5  10µ │  │
│  BLE xcvr  4  │  └────────────────────────────────────────────────────┘  │
│ MCU  …        │  3 selected              [ Compare ]  [ Export CSV ]     │
└───────────────┴──────────────────────────────────────────────────────────┘
```

Left rail groups categories (Power, Wireless, MCU, FPGA, Memory, RF, Interface,
Connectors) with counts — never a flat list of 36. Centre is the comparison table. That is
the whole app; everything else is a layer over it.

---

## The slide-over

Opening a component slides a panel over the table from the right. It is the **only**
detail surface — there is no separate page and no navigation away from your table, so your
sort, filters and selection survive.

```
                          ┌────────────────────────────────────┐
                          │ Texas Instruments            ✕     │
                          │ TPS7A0233PYCHR          ● Active   │
                          │ Tiny LDO · DSBGA-4 · 0.64×0.64 mm  │
                          ├────────────────────────────────────┤
                          │ IC area      0.41 mm²   (nominal)  │
                          │ Gross size   2.48 mm²   Estimated  │
                          ├────────────────────────────────────┤
                          │ ▸ Overview                         │
                          │ ▸ Category specifications          │
                          │ ▸ Physical                         │
                          │ ▾ Solution size                    │
                          │    Profile [Recommended      ▾]    │
                          │    A IC              0.41 mm²      │
                          │    B Externals       1.00 mm²      │
                          │    C Gross component 1.41 mm²      │
                          │    D Est. PCB   1.8×1.4  2.48 mm²  │
                          │    [ Override… ]                   │
                          │ ▾ Externals                        │
                          │    ☑ CIN 1 µF   0402  1  0.50 mm²  │
                          │    ☑ COUT 1 µF  0402  1  0.50 mm²  │
                          │    + Add external                  │
                          │ ▸ Datasheet    ▸ Notes    ▸ AI     │
                          └────────────────────────────────────┘
```

Expandable to full width for datasheet reading. `Esc` closes; `j` / `k` move to the
previous/next row *with the panel open*, so you can walk a category without closing it.

---

## The table

Requirements from the brief, all of them load-bearing:

- Sticky header, resizable and reorderable columns, column picker
- Sort by any column; numeric range filters; manufacturer, package, lifecycle facets
- Missing-data filter ("show parts with no dimensions")
- Compact / comfortable density; horizontal scroll when needed
- Virtualized rows

**Numeric alignment is not cosmetic.** Tabular figures, right-aligned, decimal-aligned,
consistent significant figures per column. A column of areas you cannot scan is a column
you will misread.

Units live in the header (`Iq (µA)`), not repeated in every cell.

### How values render

| State | Rendering |
|---|---|
| Known | `0.41` |
| Unknown | `—` in muted grey, never `0` |
| Unverified | value in grey italic with a dotted underline |
| Manual override | value with a `M` marker |
| Extracted | small superscript dot; click for page and quote |
| Fails a hard requirement | row dimmed, rank blank, tooltip naming the requirement |

Rank shows `#1 #2 #3`. A component excluded by a requirement, or missing the ranking field,
gets no rank rather than a misleading one.

---

## Comparison

Select 2–10 parts → **Compare**. Specs become rows, parts become columns.

Best and worst are tinted **only** where the spec's `better` is `lower` or `higher`.
Informational specs are never coloured — tinting "switching frequency" would assert a
preference the data does not support. IC size, gross size and the category's primary
parameters are emphasised.

---

## Size visualization

Scaled rectangles at one shared physical scale, so a 0.64 mm LDO next to a 7 mm module is
instantly, viscerally obvious. Toggle between **IC / package** and **gross estimated
solution** — the same two parts can swap places between those views, which is the entire
argument for the feature.

Unverified dimensions draw dashed rather than solid.

---

## Home

Global search, recently viewed, categories with counts and the current best-ranked part,
recently added, and a small data-quality panel:

```
12 components missing dimensions
5 missing datasheets
3 extraction fields need review
```

Actionable counts that filter the table when clicked. No vanity charts.

---

## Motion policy

Derived from how often a thing is seen. This is a tool you will use for hours; animation
that delights on day one is friction by day three.

| Element | Frequency | Decision |
|---|---|---|
| Table sort, filter, row select | Constant | **No animation.** |
| `⌘K` search palette | Constant, keyboard | **No animation.** Instant open. |
| Slide-over drawer | Occasional | 220 ms, `cubic-bezier(0.32, 0.72, 0, 1)` |
| Buttons | Constant | `scale(0.97)` on `:active`, 140 ms |
| Section expand | Occasional | 180 ms ease-out |
| Toast / confirmation | Rare | 200 ms |

Rules: only `transform` and `opacity` animate; never `transition: all`; never `ease-in` on
UI; nothing enters from `scale(0)`; `prefers-reduced-motion` drops movement while keeping
opacity.

**Never animate a measurement into looking settled while it is still changing.** When you
toggle an external and the gross size recalculates, the number changes immediately. It does
not count up.

---

## Keyboard

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Global search |
| `j` / `k` | Next / previous row |
| `Enter` | Open slide-over |
| `Esc` | Close |
| `Space` | Toggle selection |
| `c` | Compare selection |
| `/` | Focus filter |
| `⌘N` | Add component |

---

## Theme

Dark and light, both first-class, following the OS by default. Dark is not an inverted
light theme: borders, elevation and the muted greys for missing data are tuned separately
in each.

Typography: one UI sans with tabular figures, one mono for MPNs and package codes. MPNs are
strings you compare character by character — they get the mono.

---

## What is built

The screens described above exist and run. Specifics worth knowing:

**Selection and compare.** A checkbox column selects up to 10 parts; `Space` toggles the
row under the cursor and `c` opens the comparison. The compare view has an
**Only differences** filter, and the size visualization switches between package and gross
solution — the same two parts can swap order between those views, which is the argument
for the feature.

**Confirming imported dimensions.** A seeded part shows a callout naming exactly why its
dimensions are untrusted, with one button to confirm them. Confirming does not change the
numbers; it changes their status, and the part becomes rankable immediately.

**Defining a solution.** A part with no profile says so, and gross size stays blank rather
than reporting the IC footprint as a solution size. One button creates a profile; externals
are added inline with name, package, X, Y and quantity, and each row's checkbox includes or
excludes it from the calculation without deleting it.

**Overrides.** Width × height typed into the override row wins immediately and the figure
is marked `manual`. Adding more externals afterwards does not disturb it. Clearing the
override returns to the estimate.

**Export.** `Export CSV` writes the current category as displayed, with units in the header
and unverified values suffixed `(unverified)` so a spreadsheet cannot launder them into
facts. `Back up` writes the whole database as JSON, provenance included.

### Motion, as implemented

| Element | Implemented |
|---|---|
| Table sort / filter / select / `Ctrl+K` | No animation |
| Drawer | 220 ms, `cubic-bezier(0.32, 0.72, 0, 1)`, `translateX(100%)` |
| Modal | 180 ms, scale 0.98 → 1, origin centre (it is not anchored to a trigger) |
| Buttons | `scale(0.97)` on `:active`, 140 ms |
| Toast | 200 ms, 8 px rise |

`prefers-reduced-motion` removes movement from all four while keeping opacity. Nothing
animates a measurement: when an external is toggled, the gross size changes immediately
rather than counting up to its new value.

### Not yet built

Column resizing and reordering, the numeric range filter row, the density toggle, row
virtualization (unnecessary at 150 parts, necessary at 5 000), and the home screen. The
category table currently filters by part number and manufacturer only.
