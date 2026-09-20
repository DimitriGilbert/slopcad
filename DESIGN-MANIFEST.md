# slopcad — Final Composition: the Machinist system, four schemes deep

Base: Vision 2 "Machinist" @ `2e8acfb` (the judge's 9.1). Everything below was
grafted onto that tree in this worktree (`design-final`), adapted to its
system, and re-proven. The three sibling worktrees were read as sources, never
modified.

## The synthesis in three sentences

The Machinist cockpit — DRO strip, pressed keys, drawers, joined-status
timeline, the bronze-on-paper light register — remains the product; the seven
documented grafts land inside it without moving its identity. The 3D stage now
**re-materializes per scheme and register** through a ported `CadScenePalette`
(eight palettes, amber selection highlight excluded — it stays the one
deterministic domain signal). And the app's appearance became a two-axis
system: **four color schemes × two registers**, user-selectable from the
header, with Machinist as the unchanged default world every harness pins.

## Graft / adapt / drop — the decisions table

| #   | Source | What                                                      | Decision                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------ | --------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | V3     | `CadScenePalette` + per-theme studio palettes             | **Grafted, extended**       | Ported the palette prop through `cad-r3f` (`CadScene`, `CadSceneGround`, model material) and built `cad-studio-palette.ts` resolving scheme+mode → palette. Machinist keeps the night bed in BOTH registers — the judge sanctioned keeping the "scope on a light table" when preferred; it is Machinist's documented contrast move. Studios' two palettes ported verbatim; Drafting Room's scene re-authored in its spirit (vellum `#e9e6df` / ink `#0e1219`) with the model **re-inked** (warm graphite `#47423b` on vellum, warm paper-silver `#e0dacd` on ink) — fixing V1's decisive miss (stock periwinkle in every shot). Ember ports V4's navy/steel; its invisible light-register origin marker was re-inked to `#5d6673`.                           |
| 2   | V3     | Bottom full-width timeline band vs V2 inline strip        | **Adopted the band**        | Both competed for the same pixels; the judge called V3's band "the only Fusion-style" one and asked for an A/B verdict. Verdict: the band. The timeline is the document's spine and deserves the full frame width; V2's container-query collapse-to-counter existed only because the command row starved the chain — the band removes the starvation, so **whole chips stay visible at every width** (768 included), where V2 showed only "2 valid". V2's hard-won contracts all survive the move: counter outside the scrolled content (no mid-word clipping), scroll-snap whole-chip rests, edge fades, the `150px` container floor, the same `data-testid`s and the joined-status summary contract ("N valid · M parked") the render and unit suites pin. |
| 3   | V4     | Unit suffixes inside controls; `= 16 mm` expression lines | **Grafted**                 | `suffix` added to Formedible field configs + the number field (aria-hidden `data-slot="field-suffix"` tag); the parameter panel prints the current quantity as an sr-only sentence (screen readers keep the exact old words) and expressions gained their one data line. The judge's "Current value" noise is gone from the pixels. V2's pinned Apply footer and Enter-submission path are untouched.                                                                                                                                                                                                                                                                                                                                                        |
| 4   | V4     | Honest empty measurement                                  | **Grafted**                 | `measurement-section.tsx`: a row with no value does not exist; the boot state is one quiet "select a body to measure". The `toHaveCount(0)` honesty assertions still hold (they already did in the base; the empty state is now stated instead of silent em-dashes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | V4     | Quiet-when-valid timeline chips                           | **Grafted (completed)**     | The base was already quiet in ink; the valid dot is now gone entirely — a valid chip is a chip with words, failures are the only loud rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 6   | V4     | Format taxonomy chips in IO dialogs                       | **Grafted**                 | `meta?: string` on both format-option interfaces; rows carry mono tags (`mesh / binary`, `brep / worker`, …). Declarations live in `CompleteWorkbenchPage.tsx`, matching V4's verbatim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 7   | V4     | Live-render home hero + display voice                     | **Grafted, adapted**        | The front door now leads with the claim and a REAL render (the docs projection through the registry's own `CadViewport`, under the visitor's own scheme). Space Grotesk is the **display voice only** — wordmark, hero headline, surface titles — per the judge's "keep Plex for the instrument"; data stays Plex Mono.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 8   | V1     | Settle lamp                                               | **Grafted**                 | The status bar carries `data-settle-lamp="settled                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | waiting"` — the settle protocol glanceable and machine-readable. Lit while the last settled frame rendered THIS document (composition tracks the settled document identity against the live one; import previews never settle it); hollow ring otherwise. |
| 9   | V1     | Registration brackets                                     | **Grafted**                 | The viewport's corners wear the sheet-frame brackets (always on, pointer-events-none, under the preview chip when an import owns the stage) — they agree with the DRO band as the "captured region" frame.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 10  | V1     | Render-gate wrapper                                       | **Grafted**                 | `scripts/render-gate.mjs` verbatim (infra-signature-only, fails closed), wired as `pnpm test:render:gate`. It already proved its worth here: a first run died with a boot failure and the gate refused to retry it — correctly, since it was a real regression (see Honest declines).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 11  | V3     | Floor probe                                               | **Grafted, extended**       | `apps/web/scripts/floor-probe.ts` (`pnpm test:floor-probe`): 16px-step 640→2560 zero-overflow sweep + the 768 pinned-cluster check, extended across schemes and registers. Machinist takes the full 16px sweep in both registers × both modes; the other three take a 96px coarse sweep (schemes swap tokens and radius, never metrics — the coarse pass proves nothing scheme-conditional leaks into layout). **All clean.**                                                                                                                                                                                                                                                                                                                                |
| 12  | V4     | Whole-chip group wraps in the sketch band                 | **Dropped (already owned)** | V2's sketch band already wraps whole chips inside their groups; the graft would have been a no-op. V2's 768 sketch state stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| —   | V2     | The readout "double band" (DRO + status bar duplication)  | **Declined (documented)**   | Trimming the status bar would break the 28px joined-status contract the suites pin; the lamp adds instrumentation without new text. The DRO stays the glance readout, the status bar the machine surface. Known nit, unchanged from the base.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## The scheme picker — architecture

- **Two axes.** MODE stays what it was: the `.dark` class on `<html>` +
  `color-scheme`. SCHEME is new: a `data-scheme` attribute on `<html>`
  (`machinist` default, `drafting`, `studios`, `ember`) selecting a named
  token-set variant layered over the mode. Structural components never learn
  about schemes; only tokens change — including each scheme's own `--radius`
  (Machinist 0.5rem, Drafting Room 0.25rem, Studios/Ember 0), so the corner
  system follows the palette via the existing `calc()` ladder (`max()`-clamped
  so square schemes never go negative).
- **Eight token sets.** `packages/ui/src/styles/globals.css` defines
  `:root`/`.dark` (Machinist) plus `:root[data-scheme=…].dark` blocks for the
  other three — every value ported verbatim from each vision's verified
  round, with the base's custom token names (`--signal`, `--status-ok`,
  `--status-parked`) re-pointed per scheme. One real fix fell out of the new
  contrast gate: Machinist's light `--status-ok` sat at 4.32:1 — darkened to
  the text-safe `oklch(0.5 0.115 150)` the other schemes already used.
- **No-flash.** The bootstrap script now reads both `slopcad-theme` and
  `slopcad-scheme` and applies class + attribute synchronously in `<head>`
  (`APPEARANCE_BOOTSTRAP_SCRIPT`; the old name remains as a deprecated
  alias). Choices persist in localStorage; changes broadcast
  `slopcad:theme-change` / `slopcad:scheme-change` window events — no
  provider, any number of controls stay in sync.
- **The picker.** `apps/web/src/components/scheme-picker.tsx`: a Base UI
  dropdown (the shared `dropdown-menu` primitives) offering the four schemes —
  each with its dual accent swatches (light register, dark register), a
  one-line description, and a "default" tag on Machinist — and a Register
  group (Dark/Light). Server renders the styled shell button only (the
  ThemeToggle's documented pattern; Base UI menus must not SSR here); the
  portal menu mounts client-side. It ships in the app header AND the docs
  sticky bar, beside the existing quick ThemeToggle. Reachability is asserted
  in the a11y keyboard journey.
- **Scene follows.** `cad-studio-palette.ts` observes `class` AND
  `data-scheme` via one MutationObserver and hands `CadViewport` an
  identity-stable palette per scheme+mode; the scene re-inks on the next
  demand frame without remounting. Server default: Machinist dark — the exact
  world the render harnesses pin.
- **Proof.** `e2e-a11y/theme-schemes.spec.ts` parametrizes V4's light-theme
  discipline across the full matrix: 4 schemes × 2 registers × 3 surfaces,
  each forcing the persisted choice, asserting BOTH axes applied on the root,
  probing ten token pairs for WCAG AA in the rendered page, and filing a
  screenshot artifact.

## Machine surfaces

Every `data-testid`, `data-*` attribute, aria contract, label, and role the
suites assert is intact. Suite-visible updates on this branch, all following
design contracts: `ui-parameter-panel.spec.ts` now asserts the unit suffix
tags and the `= 16 mm` data line (values still asserted through the inputs;
the sr-only sentence asserted as exactly one); the keyboard journey's
timeline-control ordering follows the band (controls now close the walk,
after the docks' fields) and adds a scheme-picker tab-stop assertion; the
smoke spec asserts the new front door (hero heading, live canvas, api lamp).
New machine-readable surfaces: `data-settle-lamp`, `data-scheme`,
`data-scheme-current` (picker), `data-testid="scheme-option-*"` /
`register-option-*`. The registry was rebuilt and revalidated (44 items,
byte-fresh artifacts) after `cad-viewport` gained the shipped
`cad-studio-palette.ts` file.

## Gates

- `pnpm run verify` (check-types → lint → format:check → unit tests → build):
  **exit 0**
- `pnpm test:render:gate` → `pnpm test:render`: **87/87 passed, run 1 green**
  (byte-determinism preserved; the default scheme+dark resolves the same
  Machinist night-bed palette, so scene bytes are unchanged — page-level
  bytes shifted only where grafts legitimately moved pixels: the timeline
  band, suffix tags, brackets, lamp)
- `pnpm test:e2e` (smoke): **1/1** · `test:workbench`: **6/6** ·
  `test:components`: **12/12** · `test:docs`: **14/14** ·
  `test:projects`: **2/2** · `test:matrix`: **19/19**
- `pnpm test:a11y`: **61 passed, 0 failed** (chromium 43 = the previous 19 +
  the 24 scheme×register probes; firefox 18, with its historical WebGL skip
  plus 25 chromium-only skips on the parametrized probes)
- `pnpm registry:build` + `registry:validate`: **44 items, byte-fresh**
- Floor probe: **clean** — machinist 640→2560 @ 16px × {dark, light} ×
  {model, sketch}; drafting/studios/ember @ 96px × 8 combos; pinned-cluster
  check included.

## Evidence

`design-shots/` — 49 frames, all captured from the production build
(`vite build` + nitro node server), every one read first-hand during this
round: **workbench × 4 schemes × 2 registers × {1280, 768}** (32),
**midflow selection chain × 8** (tree row, amber body, provenance,
measurement, DRO `sel 1`, status bar in one frame, per scheme+register),
**component sheet × 8**, **docs manual × 8** (full page), **home × 2**
(live-render hero), **scheme picker open**, **ultrawide 2560 × 2**,
**command palette**, **export dialog** (taxonomy chips), **login × 2**.
The floor-probe transcript is the responsive proof for widths between shots.

## Honest declines

- **Base UI menus cannot SSR in this app** — the first composed user (the
  picker) crashed server rendering (`Cannot read properties of null
(reading 'useSyncExternalStore')`, then error #31 for labels outside
  groups). Fixed by the mounted-gate shell and grouping the labels; the
  shared `DropdownMenuLabel` wrapper (Base UI's _group_ label) remains a
  latent trap for any future un-grouped use — documented in the picker
  source, wrapper left untouched to avoid churn.
- **The readout double band** (DRO strip vs status bar) persists by
  decision, not omission — see the table.
- **Coarse (96px) sweeps for non-default schemes** — a full 16px sweep for
  all four schemes would be ~1,900 settled page loads; schemes demonstrably
  do not change metrics, so the default carries the full proof and the rest
  spot-check it.
- **Machinist light keeps the dark chamber** rather than adopting a daylight
  studio — the judge explicitly sanctioned the scope-on-light-table as
  preferred; users who want the daylight room can pick Studios or Drafting
  Room light, which is the point of shipping all four.
- **Ember light's grid** keeps V4's shipped dark lead lines on the daylight
  chamber (its judged look); only the invisible origin marker was re-inked.
- **Login page** received no bespoke re-composition this round (the base's
  instrument card stands); it re-skins correctly across schemes.

## Fix round (critic re-review, four items closed)

1. **`pnpm run verify` honesty.** The previous commit's verify claim was
   false: `format:check` failed on this manifest (written after the last
   format pass) and the earlier gate report had piped verify through
   `tail`, masking the exit code. Fixed the formatting and re-ran verify
   end-to-end under `set -o pipefail` with the exit code captured — the
   "verify exit 0" in this file is now measured, not asserted.
2. **Stale expression preview (data-truth defect).** The expression field's
   `= N mm` line (and its sr-only sentence) read the parameter's CACHED
   value, which a foreign `parameter.set` commit does not rewrite — after
   editing `holeDiameter` 8→12→20 the line still read `= 16 mm` beside a
   settled document that had moved. The panel now re-evaluates the
   defining expression against the CURRENT collection environment on every
   commit (cached value kept as the no-evaluator fallback). Pinned in
   `ui-parameter-panel.spec.ts`: post-edit `= 12 mm` + absence of the stale
   line, and a second commit (6→9 → `= 18 mm`) after the byte-replay
   comparisons so the pinned flow cannot perturb the determinism captures.
3. **Timeline chips leaked the per-scheme radius lock.** The chip, its
   suppress toggle, and the rollback gaps hardcoded 4px/3px corners —
   visibly rounded under the square Studios/Ember toolbars. All three now
   ride `rounded-sm` (the `--radius-sm` ladder step): computed radii
   verified live per scheme — machinist 4px, drafting 0px, studios 0px,
   ember 0px (the ladder clamps the 4px-radius scheme's smallest step to
   zero; machinist's 4px matches the previous look exactly).
4. **Stale evidence frame.** `workbench-midflow-drafting-light.png` showed
   the night bed; the shipped product renders the vellum bed for
   drafting+light. The full 49-shot matrix was RECAPTURED from the fixed
   build (the radius fix touches chips in three schemes' frames), and the
   recaptured frames were re-read: the drafting-light midflow now shows the
   vellum chamber with the warm-graphite→amber selected body, and the
   Studios/Ember frames show square chips.

Non-blocking notes addressed: the floor probe now always includes the
judged widths 768 and 900 as explicit probe points (neither grid landed on
900, and the coarse grid missed 768) — verified with a degenerate
2000px-step run whose probed set is exactly {640, 768, 900}. The one-frame
actionability race inside the open scheme menu (noted once during a settle
re-render, not user-facing) is recorded here as a known nit.
