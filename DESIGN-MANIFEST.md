# slopcad — Design Vision 2: "Machinist"

## The vision in three sentences

Lead with the light register, because it is where this system is genuinely ahead: **bronze on cool drafting paper** — a highlighter-amber selection wash over white instrument cards, deep-bronze primaries that pass AA as both text and fill, and the graphite 3D viewport set into the page like a scope on a light table. Dark is the same instrument at night: layered graphite, machinist amber, hairline chrome. The cockpit's signature is the **DRO strip** fused to the viewport bezel — a live `scene · extents · volume · triangles` readout no generic admin-tool vocabulary has — plus a physically pressed amber key (`:active` ink insets into the button) and pinned dock footers so the primary action never leaves the frame.

## The two registers

**Light leads (the drafting room).** Cool paper `oklch(0.977 0.003 240)`, never beige; white cards delineated by a strengthened hairline border (`oklch 0.855`) so docks keep their silhouette on dim screens; bronze primary `oklch(0.51 0.115 65)` with near-white ink (5.9:1) and as text on paper (5.7:1); the selection wash is a highlighter amber over paper. This register is co-designed, not inverted: every pair was verified AA in light first.

**Dark follows (the workshop at night).** Graphite in three steps (background 0.165 / card 0.198 / popover 0.218), amber lamp `#f0b13f` as primary with near-black ink (9.9:1), amber-steeped selection wash, the same hairline discipline.

## The rules that make it an instrument

- **Amber is semantic — brand excepted.** Amber/bronze means active, selected, live, or primary action. Brand marks (the machinist plate, the wordmark tick) are the documented exception. Hovers ride the neutral tier (`muted` wash, `border-input`), never the accent.
- **One input voice: mono.** Every field — parameter panels, the command palette query, import dialogs — is IBM Plex Mono with tabular numerals. Prose is Plex Sans; data is Plex Mono; nothing in between.
- **Corner lock.** Controls 4px, panels 6px, cards 8px, dialogs and the palette 12px — including the IO dialogs (real scrim: `black/40` + 2px blur, so the busy cockpit recedes behind a modal).
- **Labels at the smallest tier carry full contrast.** DRO labels, panel headers, and status-bar fields use `muted-foreground` unmodified (7.2:1 dark / 6.15:1 light) — no opacity modifiers at 10.5–11px. Softness comes from case, size, and tracking, never from contrast.
- **Status has its own tokens.** `--status-ok` (lamp green) and `--status-parked` (steel) are semantic; the chart family only draws charts.
- **Focus is never the shyest signal.** Focus rings ride `ring/70`–`ring/80` — brighter than any decorative element in the system.
- **Primary actions stay in frame.** Parameter docks scroll their fields and pin Apply/Rebuild as a footer; Enter still commits from any field (the form restores implicit submission itself).

## What was built

- **Token system** (`packages/ui/src/styles/globals.css`): bespoke palette, both registers first-class, status tokens, tabular mono, thin scrollbars, amber `::selection`.
- **Theme mechanism** (`apps/web/src/theme.ts`, `theme-toggle.tsx`, `__root.tsx`): no-flash bootstrap, persisted, event-synced toggles. Routes that own their chrome (docs) carry the toggle themselves — the app bar yields so pages never stack two headers or two toggles.
- **Workbench cockpit**: segmented toolbar with amber pressed state and digit keycaps; the **DRO strip** under the viewport (document and import-preview states); timeline chips with status dots; unified mono panel headers; `label = value` status bar (28px contract kept); 12px IO dialogs over a real scrim; command palette with mono query, grouped mono headings, kbd chips.
- **Component preview**: spec sheet with the Build readout promoted to a strip directly under the identity (same span ids, same session writer), pinned Rebuild footer, port map, viewport in the shared bezel, and a designed registry index for unknown ids.
- **Docs**: engineering manual — single sticky bar (brand, section jumps, toggle, session), IntersectionObserver topic rail, status-lamped example cards, bronze-glyph capability matrix.
- **Auth + home**: composed login stage (brand plate + instrument card; field contracts untouched) and the home front door with a live api lamp; per-route titles on docs, workbench, components, login, projects.

## Machine surfaces

Every `data-testid`, `data-*` attribute, aria contract, label, and role the suites assert is intact. Honest suite-visible updates on this branch: the toolbar's pressed-variant unit assertion moved from `bg-primary` to the `data-active` attribute contract; the sign-in heading copy test follows the new sentence-case heading ("Welcome back"); the parameter panel's visible Apply moved out of the `<form>` as a pinned footer that rides the same Formedible submit lifecycle, with form-level Enter submission restored (the a11y keyboard journey proves it). Scene background and material constants changed value (render baselines shift, as sanctioned); the settle protocol, determinism, and behavior are untouched.

## Gates

`pnpm run verify` exit 0 · workbench 6/6 · components 12/12 · docs 14/14 · projects 2/2 · a11y 37 passed + 1 skipped.

## Screenshots

`design-shots/` — all captured from the production build (`vite build` + node server), devtools-free: workbench-fresh, workbench-midflow (timeline populated, feature selected), workbench-command-menu, workbench-export-dialog, component-nema17, docs, home, login — each in both themes where named.

## Honest self-assessment

The ownable ground: the light drafting register, the DRO strip, the pinned dock footers, the docs manual, the NEMA17 spec sheet, and the timeline chips. The dark cockpit's chrome deliberately speaks a denser genre dialect; its differentiation lives in the DRO, the pressed-key feel, and the mono-everywhere data voice. Weakest remaining surface: the dashboard route still inherits without bespoke composition. The dev-mode-only `node:zlib` externalization on `/docs` predates this branch (same barrel import at HEAD); production and every suite are green.
