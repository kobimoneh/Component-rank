# Colour

Colour in this application carries meaning or it is not used. There is no
decorative hue anywhere: the palette is greys plus one accent, and the only
saturated colour on screen marks something you should act on.

Everything here is **computed and tested**, not chosen by eye —
`tests/colour.test.ts` reads the real tokens out of `styles.css` and does the
arithmetic, so a palette edit that breaks contrast turns a named test red.

---

## Rank — a sequential ramp, never a rainbow

Rank is magnitude, so it gets one hue with varying lightness. #1 is the
strongest step and it fades to plain by #4.

| Step | Light | Dark |
|---|---|---|
| `#1` | `#0a63d6` on white — 5.57:1 | `#4c9bff` on `#06111f` — 6.72:1 |
| `#2` | `#4d8ae6` on `#101419` — 5.36:1 | `#2f6fc4` on white — 5.01:1 |
| `#3` | `#8fb6ef` on `#101419` — 8.89:1 | `#24507f` on white — 8.30:1 |
| `#4+` | neutral chip | neutral chip |

**The ink flips per step, and that is the point.** The obvious implementation —
white text on every badge — fails: white on the lightest light-mode step is
**2.08:1** and on the lightest dark-mode step **2.82:1**. Both look perfectly
fine in a screenshot. Both are unreadable. The ink is a token per step because
the arithmetic said so.

A part with no rank shows an em dash, never a badge. Rank is never invented for
a part missing the ranking field or failing a hard requirement.

---

## Best and worst — a hint, never the message

A cell holding the leading value in its column is tinted, but **only where the
parameter declares a direction**. A parameter with `better: none` is never
coloured; tinting "switching frequency" would assert a preference the data does
not support.

An unverified value is never tinted as best. A number nobody has confirmed does
not get to win an argument.

### Why green/red is acceptable here

It normally is not. Under simulated deuteranopia the two tints are near
identical — `tests/colour.test.ts` measures this with the Viénot transform
rather than assuming it. Green/red survives because colour is the *third*
channel, not the first:

1. **The leaders strip** states the winner per parameter in plain text, above
   the table. That is the primary, non-colour answer to "who is best at what".
2. **Weight.** A best cell is `font-weight: 700`; a worst cell is not.
3. Colour, last.

The test asserts the redundancy exists precisely *because* the simulation shows
the hues collapse. If someone removes the weight cue, that test fails.

---

## Text

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--text` | 15.6:1 | 14.9:1 | values, part numbers |
| `--text-dim` | 5.9:1 | 6.5:1 | labels, secondary columns |
| `--text-faint` | 3.4:1 | 3.6:1 | counts, hints, units in headers |

`--text-faint` sits below 4.5:1 deliberately and is therefore restricted to text
you never act on — a row count, a keyboard hint, a unit already stated in the
header. No engineering value is ever rendered in it.

Series colour never lands on text. A value stays in ink; the badge or tint
beside it carries identity.

---

## Materials

Chrome is translucent — `backdrop-filter: blur(24px) saturate(180%)` over a
semi-transparent surface, with content moving underneath, plus a one-pixel
bright top edge so the material catches light. Bigger surfaces blur harder and
cast deeper shadows than small chips.

Three preference queries are honoured, because a translucent instrument panel is
exactly the kind of interface that hurts people who have asked for less of it:

- `prefers-reduced-motion` — movement is dropped, opacity kept. Gentler, not absent.
- `prefers-reduced-transparency` — every glass surface becomes solid and the blur
  is removed.
- `prefers-contrast: more` — borders strengthen, chrome goes opaque, the
  unverified underline thickens.

---

## Both themes are designed

Dark is the default. Light is not an inverted dark theme and dark is not an
inverted light one: borders, elevation, the muted greys for missing data, and
the entire rank ramp are specified separately and validated separately against
their own surface.
