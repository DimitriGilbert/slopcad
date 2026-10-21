# slopcad — the instrument design system

The law for how this product looks. `DESIGN-MANIFEST.md` records the design
round that produced the current palettes; this file is the system built on
top of them and the rules every surface must keep. The system is rendered,
not just described: `/design` shows every token and primitive in every
state, and `apps/web/scripts/design-shots.ts` shoots it across all four
schemes in both registers.

## The idiom

**Plasticity's restraint with Onshape's information density.** Dark neutral
chrome, a viewport that is its own material, keyboard-first, dense but
legible. No ribbon. The product is an instrument: the geometry is the only
thing allowed to be loud.

## The two axes

| Axis         | Carrier                   | What it changes                    |
| ------------ | ------------------------- | ---------------------------------- |
| **Register** | `.dark` on `<html>`       | light or dark chrome — the user's  |
|              | (+ `color-scheme`)        | mode choice, nothing else          |
| **Scheme**   | `data-scheme` on `<html>` | hue, chroma, accent, corner radius |

**A scheme never flips the register.** There is no light-chrome scheme and
no dark-chrome scheme — Drafting Room is a palette, not a register. This is
the resolution of the light-register conflict: anything that wants light
chrome asks for light mode. A scheme supplies colour; it never supplies a
metric, a layout, or a register.

## One ramp, four schemes

Every surface, rule, ink and shadow value is an oklab delta off the scheme's
own `--background` / `--foreground`. The only register-conditional values in
the whole system are the step AMOUNTS (`--rise-*`, `--sink-*`,
`--rule-*-amount`, `--shadow-amount`), declared once in `:root` and once in
`.dark` in `packages/ui/src/styles/cockpit.css`. Adding a fifth scheme means
adding a palette, not a ramp.

### Surfaces — five rungs

| Token          | Job                                           |
| -------------- | --------------------------------------------- |
| `well-deep`    | key caps, scrub tracks, the deepest inset     |
| `well`         | inset fields, section header bands, hover     |
| `chrome`       | the frame: header, rails, status bars, gaps   |
| `panel`        | a docked panel's face                         |
| `panel-raised` | a panel sitting over another panel            |
| `overlay`      | popovers, menus, dialogs, the command palette |

`overlay` is the **only** rung that carries a shadow, and the shadow is
tinted to the scheme (`--shadow-ink`), never black. Docked chrome is flat:
depth in a cockpit comes from rules and value, not from drop shadows.

### Ink — three steps, one family

`ink` (primary text) → `ink-dim` (labels, idle controls) → `ink-faint`
(units, counts, placeholders). There is never a second grey family and never
a warm grey beside a cool one; `ink-dim` and `ink-faint` are mixes of the
scheme's own foreground toward its own background.

### Rules — two weights

`rule` separates, `rule-strong` encloses. A boundary that needs more
emphasis than `rule-strong` needs a surface change instead, not a third
weight.

## Type — six sizes, leading fixed at the token

| Token        | Size | Job                                     |
| ------------ | ---- | --------------------------------------- |
| `text-title` | 15px | panel and dialog names                  |
| `text-body`  | 13px | the only size prose may use             |
| `text-ui`    | 12px | controls, tree rows, menu items         |
| `text-data`  | 12px | measured values — mono, tabular, always |
| `text-label` | 11px | field labels                            |
| `text-micro` | 10px | units, key caps, counts                 |

IBM Plex Sans is the instrument voice, IBM Plex Mono every number that can
change, Space Grotesk the display voice — the wordmark, the front door, and
surface titles, never panel chrome and never data. Numbers are
`tabular` wherever they update, so a live readout never shifts its
neighbours.

Section headers are small caps (`label-section`, 10px, +0.08em). This is a
deliberate deviation from the general "no all-caps labels" guidance: it is
the vernacular of every parametric CAD surface, and at 10px with that
tracking it reads as a rule, not as shouting. It is allowed **only** for
panel and section names — never above prose, never as an eyebrow.

## Density — the metrics are tokens

24px row, 24px control, 28px tool button, 26px panel header, 40px app bar,
240px rail, 8px panel pad, 6px row pad, 6px control gap. One edit to `cockpit.css` re-tunes every
panel, which is why no component may hardcode a height. Nothing inside a
panel is taller than a tool button.

## Accent — one colour, three jobs

The scheme's `--signal` appears on:

1. the **armed** tool (`aria-pressed` — a wash plus a 1px edge),
2. the **selected** entity (row wash + the signal edge on the inline start,
   and the viewport's selection highlight),
3. one **confirming** action per surface.

That is the whole list. The accent never fills a slab, never decorates a
heading, never tints an icon for emphasis and never appears twice in one
glance. If two things on screen are amber, one of them is wrong.

## Focus and selection

Focus is a 2px `--focus` outline at a 1px offset — an **outline, not a
glow** — identical on every control, via the `focus-instrument` utility.
Selection is published as state (`data-selected`, `aria-pressed`,
`aria-selected`), never as colour alone, so tests and screen readers read
the same truth the eye does. A status is the same: `StatusDot` is
`aria-hidden` and carries its word beside it.

## The viewport is its own surface

The 3D bed does not inherit the chrome's register — Machinist keeps a night
bed under light chrome on purpose ("a scope on the light table"). So the
viewport has its own tokens, declared per scheme × register from two inputs
(`--viewport`, `--viewport-contrast`) and deriving `--viewport-ink`,
`--viewport-ink-dim`, `--viewport-rule`, `--viewport-rule-strong` and
`--viewport-scrim` from **those**, never from `--background`.

The surface has two halves with two consumers, and they are kept in sync by
value:

- **DOM half** — `cockpit.css`: the frame, the corner ticks, the readout
  scrim, HUD ink.
- **GL half** — `packages/ui/src/components/cad/cad-studio-palette.ts`: the
  clear colour, grid, axes and model ink three.js draws, typed and frozen
  for identity-stable R3F rendering.

`--viewport-select` is `#f59e0b` in every scheme and both registers, matching
`CAD_SELECTION_HIGHLIGHT_COLOR` exactly: selection is a **domain signal**,
not a theme decision.

## Motion

Motion is state feedback only: `--dur-press` (90ms) for a press,
`--dur-state` (140ms) for a hover or an armed change, on
`--ease-instrument`. Only `background-color`, `color`, `border-color`,
`opacity` and `transform` are ever animated. `prefers-reduced-motion`
collapses both durations to zero, which costs nothing because nothing in the
cockpit is animated for delight.

## Primitives

`packages/ui/src/components/cockpit/`:

| Primitive                                              | Contract                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `Panel` / `PanelHeader` / `PanelBody` / `PanelSection` | the enclosure: a rung, a rule, a name strip, stacked sections that never become cards |
| `ToolButton` / `ToolGroup`                             | quiet until armed; `aria-pressed` is the armed truth; a group is always named         |
| `KeyCap`                                               | `aria-hidden` by contract — the control carries `aria-keyshortcuts`                   |
| `PropertyRow`                                          | label left, tabular value right, 24px, hairline below                                 |
| `Readout`                                              | a DRO cell: dim name, mono tabular value                                              |
| `StatusDot`                                            | a 6px lamp that always carries its word                                               |

## The floor, every surface

Responsive to the 768px drawer band, visible keyboard focus on every
control, `prefers-reduced-motion` respected, WCAG AA text pairs in both
registers of all four schemes, no colour-only state, semantic landmarks, and
no surface that has not been screenshotted.
