# slopcad — Design Vision 2: "Machinist"

## The vision in three sentences

slopcad is a precision instrument, and its interface should feel like one: a graphite cockpit where every readout is mono, every state has one honest color, and the 3D viewport sits framed like the instrument screen it is. The identity is **machinist amber on workshop graphite** (dark) and **bronze on cool drafting paper** (light) — the machine-tool signal language (stack lamps, DRO readouts, selection washes), not another blueLinear clone. Nothing decorative survives: every amber pixel means "active, selected, or live," and everything else is hairline, ink, and whitespace.

## Identity system

**One accent, two inks.** The accent is the machinist amber family. In dark it is a lamp: `oklch(0.80 0.145 78)` (`#f0b13f`) as primary fill with near-black ink (9.9:1). In light it is the same hue deepened into bronze `oklch(0.51 0.115 65)` (`#8a580c`) so it passes AA as both text on paper (5.7:1) and fill with near-white ink (5.9:1). The brand reads as one color across themes because it is one hue — only lightness adapts.

**Neutrals with a breath of blue, never gray-mush.** Dark layers graphite in three steps (background 0.165, card 0.198, popover 0.218) with hairline borders at 0.295. Light uses cool paper (`#f6f8f9`) with white cards — deliberately _not_ beige, _not_ warm cream: this is a drafting room, not a bakery.

**Typography: IBM Plex, the engineering document face.** IBM Plex Sans Variable for UI, IBM Plex Mono for every number, id, path, and status (`font-variant-numeric: tabular-nums` globally on mono so readouts never reflow). Plex has genuine engineering-document heritage, distinctive letterforms at 11–13px, and a mono that pairs natively. Self-hosted via Fontsource — no network dependency, e2e-safe.

**Corner system (shape lock).** Controls and chips 4px, panels 6px, cards 8px, dialogs/palette 12px. Documented and applied everywhere — no mixed radii.

**The viewport is an instrument screen.** The 3D scene stays in its authored studio graphite in both themes (deterministic, the settle contract untouched), framed in a 1px bezel with inset highlight — in light theme it reads as a scope set into a paper page. The model material was retuned to light steel `#aabdd6` so geometry separates cleanly from the background.

## What was built

- **Token system** (`packages/ui/src/styles/globals.css`): complete rewrite of the default shadcn palette; both themes first-class; new `--signal` token (the raw state color), `--destructive-foreground`, amber-tinted `--accent` selection washes per theme, chart family anchored on the accent; thin instrument scrollbars; amber `::selection`; tabular mono.
- **Theme mechanism** (`apps/web/src/theme.ts`, `components/theme-toggle.tsx`, `__root.tsx`): inline no-flash bootstrap script (defaults dark, persisted in localStorage, `color-scheme` set for native controls), event-synced toggles in the app header and the docs rail, `suppressHydrationWarning` on `<html>`.
- **Workbench cockpit**: segmented tool strip with amber pressed state and digit keycaps; timeline chips with status dots and mono kinds; panel chrome unified under 10.5px mono uppercase headers with hairline dividers; status bar as a `label = value` machine readout (28px contract kept); viewport bezel; command palette with grouped mono headings, amber selection wash, and kbd shortcut chips.
- **Component preview**: spec-sheet layout — name/identity header, bordered id chip, three instrument cards (Parameters via Formedible, Interface port map, Build readouts), viewport in the shared bezel.
- **Docs**: engineering-manual structure — sticky in-page bar with section jumps and theme toggle, IntersectionObserver-driven topic rail (no scroll listeners), example cards with semantic status lamps (running pulses amber, ok glows green, failed red), capability matrix and format tables with bronze ✓ glyphs, guide paths as mono chips.
- **Home**: the front door — brand mark, one headline, two CTAs, live api lamp, and a three-surface index.
- **Primitives**: Button (amber primary with inset highlight, hairline outline, 4px), Input (mono, tabular, focus ring), Badge (tinted, bordered), Command (rounded palette), scene background `#101318`.

## Machine surfaces

Every `data-testid`, `data-*` attribute, aria contract, label, and role the suites assert is intact. The one intentional suite-visible change: the a11y suite's screenshots now capture the new skin (they are artifacts, not baselines). One unit test's class assertion (`bg-primary` on the armed tool) was updated to the new distinct-variant contract (`data-active` attribute), preserving the test's intent. Scene background and material constants changed value (render baselines shift, as sanctioned); the settle protocol, determinism, and behavior are untouched.

## Gates

`pnpm run verify` exit 0 (check-types, lint, test, build) · workbench 6/6 · components 12/12 · docs 14/14 · projects 2/2 · a11y 37 passed + 1 skipped.

## Screenshots

`design-shots/`: workbench-fresh, workbench-midflow (timeline populated, hole feature selected), workbench-command-menu, component-nema17, docs, home — each in both themes where named.

## Honest self-assessment

The strongest surfaces are the workbench cockpit and the command palette — they look like a real, shippable CAD product with a point of view. The light theme is genuinely co-designed (bronze-on-paper with equal contrast rigor), not an inversion. The weakest link is the auth/projects surface: it inherits the system (tokens, forms, buttons) but got no bespoke composition — acceptable coherence, not a showcase. The dev-mode-only zlib externalization on `/docs` predates this branch (same barrel import at HEAD); the production build and all suites are green.
