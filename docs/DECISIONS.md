# Engineering Decisions

Decisions that were not obvious, and what forced them. Where a measurement disagreed with a
plan, the measurement won and the disagreement is recorded here rather than quietly fixed.

---

## D1 — `node:sqlite` instead of `better-sqlite3`

**Context.** The brief specified SQLite; `better-sqlite3` is the default choice.

**What happened.** `better-sqlite3` installed and `electron-rebuild` succeeded, but the
resulting binary was compiled for Electron's ABI (`NODE_MODULE_VERSION 130`). System Node
is 137, so Vitest could not load it:

```
Error: The module '…/better_sqlite3.node' was compiled against a different
Node.js version using NODE_MODULE_VERSION 130. This version of Node.js
requires NODE_MODULE_VERSION 137.
```

Every database, migration and repository test would have run against a *different* binding
than the app ships.

**Measurement.** Electron 43 bundles Node **24.18.1** — identical to system Node here — and
its built-in `node:sqlite` was verified working: SQLite 3.53.1, FTS5 functional, no
experimental flag.

**Decision.** Electron 43 + `node:sqlite`. No native modules at all: no `electron-rebuild`,
no `node-gyp` on the Windows packaging path, no ABI split, and tests exercise the production
driver.

**Cost.** `node:sqlite` has a smaller API than `better-sqlite3` (no user-defined functions,
narrower backup API). Nothing in this design needs them. The driver sits behind a
`SqlDriver` interface, so swapping back is contained.

---

## D2 — `node:sqlite` will not resolve through Vite

**Symptom.** `Failed to load url sqlite (resolved id: sqlite)`.

**Cause.** `node:sqlite` is a **prefix-only** builtin. `module.builtinModules` contains
`"node:sqlite"` but *not* `"sqlite"`. Vite strips the `node:` prefix before checking that
list, concludes it is a package named `sqlite`, and fails.

```
> node -p "require('module').builtinModules.includes('sqlite')"
false
> node -p "require('module').builtinModules.includes('node:sqlite')"
true
```

**Tried and rejected:** `ssr.external`, `test.server.deps.external`, and a `resolveId`
plugin returning `{ external: true }`. Vitest's transform pipeline still attempted the load.

**Decision.** Load it via `createRequire(import.meta.url)` in `src/db/driver.ts`, with an
`import type` for typing (erased at compile time). Keeps it out of static analysis in both
the test runner and the Electron main bundle, with no build configuration at all.

---

## D3 — Canonical length is millimetres, not metres

"Store canonical SI values" would suggest metres. A 2.5 mm package would store `0.0025`,
and an area `5.46e-6`.

**Decision.** Canonical length is `mm` and area `mm²`. Millimetres are SI, the whole app is
about PCB dimensions, and a stated requirement is that the database stays yours and
portable — which means readable when you open it in a SQLite browser. `2.5` and `5.46` are
readable. `0.0025` invites a misplaced decimal.

Electrical dimensions keep their SI base (V, A, W, Hz, F, H, Ω).

---

## D4 — Logarithmic units are their own dimensions

`dBm` could be converted to mW. It is defined and unambiguous.

**Decision.** `dB` (`ratio_log`) and `dBm` (`power_log`) are separate dimensions from
`power`, so any automatic conversion is refused by the existing dimension check.

**Why.** Ranking by "power" across a mix of dBm and mW values silently compares a
logarithmic reading with a linear one. Anyone who genuinely wants the conversion must do it
explicitly, which makes it visible. Refusing beats a plausible wrong number.

Kelvin is excluded from the temperature dimension for the same reason: it differs from °C
by an *offset*, and this registry is multiplicative. Refusing is better than being wrong by
273.15.

---

## D5 — A unit from the wrong dimension is an error, not a fallthrough

**Found by a test.** `toCanonical(300, 'K', 'temperature')` returned `300000` instead of
throwing. `'K'` was registered as an alias of `kΩ`, and the lookup fell through to another
dimension and applied its factor. A temperature became a resistance, silently.

**Decision.** Two fixes: the bare `'K'` alias is gone, and `resolve()` now throws when the
resolved dimension is not the one the caller expected. `parseQuantity` returns `null` in the
same situation rather than converting across dimensions.

This is the exact failure class the project is built to prevent — not a crash, a believable
wrong number. It survived review and was caught only because a test asserted the *refusal*
rather than the value.

---

## D6 — `key_parameters` are translated by a lexicon, not by code or an LLM

`config.yaml`'s `key_parameters` are prose research hints: 205 references, 100 distinct
strings, where one string can be three specifications and another is a derived value.

**Rejected:** heuristic string parsing (unreviewable, silently wrong), and an LLM at import
time (non-reproducible, needs a network, unreviewable diff).

**Decision.** `resources/spec-lexicon.yaml`, a hand-written, editable mapping covering all
100 phrases. Unmatched phrases degrade to an editable `text` spec flagged `unmapped` and
surface in the category editor. A test asserts zero unmapped against the real config, so an
upstream phrase nobody has typed becomes a failing test, not a degraded column.

---

## D7 — The YAML colon trap is upstream, and guarded here

Three `key_parameters` entries in `config.yaml` contain `": "`, so YAML parses them as
dicts rather than strings:

```python
{'Supply / on current (HARD': 'must be < 6 mA)'}
```

Two of the three carry their category's **hard constraints** (`rf-lna-400mhz`,
`fpga-pcie`). Any consumer treating the list as `string[]` throws or drops them.

**Decision.** `flattenKeyParameter()` rebuilds `"key: value"` verbatim so the text survives
and matches the lexicon. A test feeds the real fixture and asserts the `< 6 mA` and
`covers 400 MHz` requirements exist.

**Upstream note.** Quoting those three strings in `component-report/config.yaml` would make
them parse as intended. Worth fixing there.

---

## D8 — Package dimensions default to maximum, and say which basis they used

The brief requires maxima and forbids silently substituting nominal. Real data often gives
maxima on one axis only.

**Decision.** Per-axis selection (max → nominal → min), with the basis reported per axis and
an overall basis of `max`, `nominal`, `min`, or **`mixed`**. `mixed` is displayed rather
than rounded up to `max`, because claiming a uniform basis the data does not have is the
same class of error as using the nominal.

An axis with no value at all makes the area `null`. It does not become zero and rank the
part as the smallest thing in the category.

---

## D9 — The gross-size estimator is a named heuristic, not a layout

D (estimated PCB rectangle) cannot be exact without doing placement and routing.

**Decision.** A deterministic shelf-pack: inflate each part by a courtyard margin, pack by
decreasing height across candidate widths, pick minimum area, apply a routing allowance.
All three assumptions are configurable and travel with the result so the UI can name them.
Output is tagged `Estimated`, and a manual override always wins and is never recomputed
away.

Deterministic matters: no clock, no randomness, so the figure is reproducible and testable.
Tests assert stability across repeated runs, independence from external ordering, and
`D > C` always — a `D ≤ C` would mean the estimator had started reporting component area as
board area.

---

## D10 — Seed data imports identity as fact and dimensions as unverified

`reports/2026-06/parts.json` has 160 real parts. MPN, manufacturer and datasheet URL are
facts. The prose `headline` dimensions are LLM-written.

**Decision.** Import identity as real components. Parse only **explicit** `W × H mm` pairs
into a package marked `imported` / `is_unverified`, excluded from ranking until confirmed.

Package codes are never used to infer dimensions. The real data contains
`"0.99 mm² (0403)"`, which does not match the imperial 0403 footprint — inferring from the
code would have manufactured a wrong number in the app whose whole purpose is size.

---

## D11 — The slide-over is the only detail surface

The brief asks for both a slide-over and a "dedicated detail page".

**Decision.** A right-side drawer over the table, expandable to full width and
deep-linkable. No separate page.

**Why.** Navigating away loses your sort, filters and selection — the working state you
built to answer a question. The drawer keeps the table alive underneath, and `j`/`k` walk
rows without closing it.

---

## D12 — Evidence verification, not prompt discipline

"Never hallucinate" in a prompt is a request, not a mechanism.

**Decision.** Every extracted field must carry a verbatim quote and a page number, and the
quote is searched for in the text actually extracted from that page. A value whose quote is
not found is never stored as confirmed.

To fabricate a number, a model must also fabricate a quote that happens to appear in the
PDF. That turns an unfalsifiable claim into a checkable one — and it is a pure function,
testable without a model.

---

## D13 — A component can belong to several categories

**Found by real data.** Seeding the 160 parts created only 150 components: ten were
rejected as duplicates. They were not duplicates. `RF1630` is listed by
`component-report` under RF switch 2.4 GHz, cellular *and* 5–6 GHz; `GRF5510` under
sub-GHz and cellular PA; `QPL9547` under 2.4 GHz and 5–6 GHz LNA.

A single `component.category_id` silently dropped those parts from two of the three
categories they genuinely belong to. Opening "RF switch — cellular" would not have shown
one of its best candidates, and nothing would have said so.

**Decision.** Added `component_category(component_id, category_id, is_primary)`.
`component.category_id` remains the primary category shown on the part itself; browsing
and ranking go through the membership table. The part stays one row — one MPN, one set of
dimensions, one solution profile — appearing in every category it serves.

150 components, 160 memberships. A test asserts `RF1630` appears in all three switch
categories while `SELECT COUNT(*) … WHERE mpn_norm='RF1630'` returns exactly 1.

---

## D14 — Main and preload are CommonJS

`electron-vite` follows `package.json` `"type": "module"` and emits ESM for the main
process. Electron 43 does support ESM in main, but the conventional and best-supported
form — and the required form for preload scripts — is CommonJS. Main and preload are
built with `output: { format: 'cjs', entryFileNames: '[name].cjs' }`.

**A debugging note that cost real time here.** The symptom that started this was
`TypeError: Cannot read properties of undefined (reading 'whenReady')`, with
`require('electron')` returning an empty object and named ESM imports failing. The cause
was not Electron's module format at all: **`ELECTRON_RUN_AS_NODE=1` was set in the
environment**, which makes the Electron binary run as plain Node, with no `app`, no
`BrowserWindow` and no browser init. The stack trace gives it away — it shows
`node:electron/js2c/node_init` rather than `browser_init`, and Node's own error formatter.

If you ever see an empty `electron` module, check that variable before changing anything.
