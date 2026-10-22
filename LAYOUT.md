# slopcad — the cockpit layout law

`DESIGN.md` is the law for how the product LOOKS: tokens, surfaces, ink,
accent, motion, primitives. This file is the law for how it is BUILT:
which zone owns which pixels, which component fills each zone, and what
each one must become. Where the two disagree about structure, this file
wins; where they disagree about colour or metric, `DESIGN.md` wins.

Written at the head of branch `redesign/pro-cad-v2`, Step 1 (layout
lock). The audit below describes the repo as it is at that commit — it
is a starting map, not an aspiration, and every "today" row was read out
of the file it names.

---

## 0. Which workbench is the product

There are nine `workbench*`/`drawings` routes. Only one of them is the
product; the rest are fixtures that exist to pin kernel behaviour, and
they are explicitly OUT of scope for the redesign.

| Route                              | Page component                                | Status                          |
| ---------------------------------- | --------------------------------------------- | ------------------------------- |
| `/_auth/documents/$documentId`     | `cad-projects/ProjectWorkbenchPage.tsx`       | **THE PRODUCT** — persisted doc |
| `/workbench-complete`              | `cad-workbench/CompleteWorkbenchPage.tsx`     | **THE PRODUCT** — bare/unsaved  |
| `/workbench-complete-occt`         | same page, backend pinned                     | fixture                         |
| `/workbench`                       | `cad-workbench/CadWorkbenchPage.tsx`          | legacy fixture (pinned DOM)     |
| `/workbench-chain`                 | `cad-workbench/CadChainWorkbenchPage.tsx`     | legacy fixture                  |
| `/workbench-analysis`              | `cad-workbench/analysis-workbench.tsx`        | fixture                         |
| `/workbench-assembly`              | `cad-workbench/assembly-workbench.tsx`        | fixture                         |
| `/workbench-assembly-motion`       | `cad-workbench/assembly-motion-workbench.tsx` | fixture                         |
| `/workbench-assembly-interference` | `cad-workbench/interference-workbench.tsx`    | fixture                         |
| `/workbench-sim`                   | `sim-workbench/SimWorkbenchPage.tsx`          | fixture                         |
| `/drawings`                        | `cad-workbench/drawing-workbench.tsx`         | separate surface (2D drawing)   |

Both product routes bottom out in the SAME composition:
`apps/web/src/cad-workbench/complete-workbench.tsx` →
`CompleteCadWorkbench` (3594 lines). `ProjectWorkbenchPage` mounts it
with a `bar` slot (the persistence chrome) and nothing else differs.

**Therefore: `complete-workbench.tsx` is the cockpit.** Every zone below
is a region of that one file's render tree, and the redesign's job is to
decompose it into real zone components instead of continuing to grow it.

`CadWorkbenchPage.tsx`'s `WorkbenchLayout` is a second, older layout
(centered `flex items-center justify-center p-3`, floating 192px
palettes, `border-border bg-background` legacy tokens) whose DOM is
deliberately pinned by render fixtures. It is NOT the product and must
not be "fixed" — it is a baseline.

---

## 1. The audit: what exists today

### 1.1 The composition root

`complete-workbench.tsx` renders one `<div class="flex h-full min-h-0
flex-col">` carrying ~40 `data-*` machine attributes, then five stacked
children:

1. optional host `bar` band (persistence chrome, slot-supplied)
2. the command row — `h-(--appbar-h)`, `bg-chrome`
3. `SketchMode` (replaces everything below when `mode === "sketch"`)
4. the workspace row — `relative flex min-h-0 flex-1`
5. the feature-timeline band — `h-9`, `bg-chrome`
6. the status frame — `CadStatusBar` + the settle lamp

The composition exposes every surface as a named render-prop slot
(`CadWorkbenchSlots`: `toolbar`, `commandMenu`, `viewport`, `modelTree`,
`propertyPanel`, `parameterPanel`, `configurationPanel`,
`historyTimeline`, `statusBar`). **That slot contract is the lever the
whole redesign turns on** — a zone can be replaced wholesale without
touching the 3500 lines of engine wiring around it.

### 1.2 Component inventory

| Component                        | File                                                         | Lines | Built of                                               |
| -------------------------------- | ------------------------------------------------------------ | ----- | ------------------------------------------------------ |
| `CompleteCadWorkbench`           | `apps/web/src/cad-workbench/complete-workbench.tsx`          | 3594  | hand-rolled divs + every component below               |
| `useWorkbenchEngine`             | `apps/web/src/cad-workbench/workbench-engine.tsx`            | 4715  | all document/tool/history state (no DOM)               |
| feature forms                    | `apps/web/src/cad-workbench/feature-forms.tsx`               | 3548  | Formedible configs for the 18 feature dialogs          |
| `SketchMode`                     | `apps/web/src/cad-workbench/SketchMode.tsx`                  | 1705  | legacy `Button` + `bg-card/50`, flex-wrap canvas stage |
| `CadModelTree`                   | `packages/ui/src/components/cad/cad-model-tree.tsx`          | 1293  | own divs; popover; NO `Panel`                          |
| `CadSketchCanvas`                | `packages/ui/src/components/cad/cad-sketch-canvas.tsx`       | 1279  | fixed-size SVG                                         |
| `CadParameterManager`            | `packages/ui/src/components/cad/cad-parameter-manager.tsx`   | 1258  | own divs; popover                                      |
| `CadSketchInspector`             | `packages/ui/src/components/cad/cad-sketch-inspector.tsx`    | 918   | own divs; NO `Panel`, NO `PanelHeader`                 |
| `CadParameterPanel`              | `packages/ui/src/components/cad/cad-parameter-panel.tsx`     | 763   | `PanelHeader` + own body                               |
| `WorkbenchRightSidebar`          | `apps/web/src/cad-workbench/right-sidebar.tsx`               | 369   | legacy `bg-card`, `shadow-2xl`, `%` splits             |
| `CadPropertyPanel`               | `packages/ui/src/components/cad/cad-property-panel.tsx`      | 658   | `PanelHeader` + `PropertyRow`                          |
| `CadViewport`                    | `packages/ui/src/components/cad/cad-viewport.tsx`            | 644   | R3F canvas + `overlay` render-prop                     |
| `CadViewportViewTools`           | `apps/web/src/cad-workbench/viewport-view-tools.tsx`         | 635   | `ToolButton`s in a bottom-right overlay panel          |
| `CadIoDialog` (import/export)    | `packages/ui/src/components/cad/cad-io-dialog.tsx`           | 464   | `Dialog`                                               |
| `CadSketchToolbar`               | `packages/ui/src/components/cad/cad-sketch-toolbar.tsx`      | 386   | legacy `Button`, text labels, `bg-background`          |
| `FeatureTimelineStrip` (+ parts) | `apps/web/src/cad-workbench/feature-timeline-strip.tsx`      | 353   | chips on system tokens                                 |
| `CadConfigurationPanel`          | `packages/ui/src/components/cad/cad-configuration-panel.tsx` | 366   | `PanelHeader` + `ToolButton`                           |
| `CadCommandMenu`                 | `packages/ui/src/components/cad/cad-command-menu.tsx`        | 327   | `Command` (cmdk)                                       |
| `CadToolbar`                     | `packages/ui/src/components/cad/cad-toolbar.tsx`             | 234   | `ToolButton` + `KeyCap`, text labels, pill container   |
| `CadStatusBar`                   | `packages/ui/src/components/cad/cad-status-bar.tsx`          | ~260  | on system tokens                                       |
| `WorkbenchMeasurementSection`    | `apps/web/src/cad-workbench/measurement-section.tsx`         | ~200  | `PanelHeader` + `ToolButton`                           |

### 1.3 Primitives, and how little they are used

`packages/ui/src/components/cockpit/` holds exactly three files:
`panel.tsx` (`Panel`, `PanelHeader`, `PanelBody`, `PanelSection`),
`tool-button.tsx` (`ToolButton`, `ToolGroup`, `KeyCap`),
`property-row.tsx` (`PropertyRow`, `Readout`, `StatusDot`).

The damning part of the audit:

- **`Panel` is imported by ZERO cockpit surfaces.** Its consumers are
  `routes/index.tsx`, `login.tsx`, `_auth/dashboard.tsx`,
  `_auth/projects.index.tsx`, `_auth/projects.$projectId.tsx`,
  `docs-app/DocsPage.tsx`, `docs-app/live-examples.tsx`,
  `viewer/ViewerSurface.tsx`, `design/DesignSystemPage.tsx` — the
  marketing/admin/demo surfaces. The workbench's own docks are
  hand-rolled `<div>`s with inline `border-r border-rule bg-panel`.
- **`PanelBody` and `PanelSection` have exactly one consumer each, and
  it is `design/DesignSystemPage.tsx`** — the gallery that exists to
  render the primitives. They have never been used by a real surface.
- **`ToolGroup` has two consumers**: `cad-configuration-panel.tsx` (with
  `separated={false}`) and one call in `complete-workbench.tsx` (L2221,
  inside the sketch hint card). The command row itself hand-rolls its
  groups as `<div role="group" aria-label=…>` with
  `<div aria-hidden className="h-5 w-px bg-rule" />` dividers.
- `ToolButton` reached `cad-toolbar`, `cad-configuration-panel`,
  `cad-parameter-panel`, `viewport-view-tools`, `measurement-section`
  and the complete workbench — but NOT `cad-sketch-toolbar`, which is
  still raw `Button` on `border-border bg-background`.

This is the structural reading of "tokens landed, structure didn't": the
primitives exist, the cockpit does not consume them.

### 1.4 The command row's actual condition

The single `h-(--appbar-h)` row currently holds, left to right:

- a drawer toggle (`xl:hidden`),
- the "document plate" (a dot + scene kind + extents + feature count),
- a 1px divider, `CadToolbar` (4 tools: select/measure/translate/rotate,
  **text labels**, in a `rounded-md border bg-card/60` pill that the host
  then neutralises with `className="border-0 bg-transparent p-0"`),
- a divider, undo/redo,
- the command-menu trigger,
- Import, Export,
- and then **19 text-label verbs**: Hole, Hole (spec), Sweep,
  Loft, Helix, Thread, Draft, Rib, Scale, Thicken, Split, Pattern,
  Pattern (path), Mirror, Boolean, Move body, Sketch on face, Datum,
  Sketch, plus the right-side drawer toggle.

Because that does not fit, the row is held together with
**width-conditional hiding**: `max-xl:hidden` on 6 verb buttons (Hole,
Sweep, Loft, Helix, Thread, Datum — plus three more on label `<span>`s
that merely collapse a label), `max-2xl:hidden` on 5 (Draft, Rib, Scale,
Thicken, Split), and `max-[1799px]:hidden` on 7 (Hole spec, Pattern,
Pattern path, Mirror, Boolean, Move body, Sketch on face). A hard-coded
pixel breakpoint named after a measurement of the row itself is the
clearest possible signal that the row is the wrong container. Below those
widths the verbs are reachable only through the command palette.

**This row is the single biggest structural defect in the product.** It
is a ribbon pretending not to be one, and it is what the TOP zone exists
to replace.

### 1.5 Sketch mode's actual condition

`SketchMode` is not a cockpit at all:

- its command row is `border-border bg-card/50` with legacy `Button`s
  (Model, Extrude, Save, axis x/y/z, Revolve, a raw `<input type=file>`
  styled with `border-input bg-background`, Undo, Redo) AND the entire
  `CadSketchToolbar` (3 groups, ~36 tools, **text labels**, wrapping)
  inline in the same row;
- its workspace is
  `flex min-h-0 flex-1 flex-wrap items-start justify-center gap-3
overflow-y-auto p-3` containing a **fixed-size SVG canvas** and the
  inspector as a `shrink-0` sibling — i.e. a centred document on a page,
  not a viewport in a frame;
- its status line is `border-border bg-card/50 h-7 font-mono
text-[11px]` — a hardcoded size outside the type scale.

Sketch mode must become the same five-zone cockpit as model mode, with
the zones' CONTENTS swapped, not a different page.

### 1.6 The right dock's actual condition

`WorkbenchRightSidebar` is resizable (good, keeps the separator a11y
pattern) but is still on legacy tokens — `border-border bg-card
shadow-2xl`, `xl:bg-card/40`, `hover:bg-primary/30` on the handle — and
splits its three panels by **hardcoded percentages**:
`max-h-[55%]` property, `flex-1` parameter, `max-h-[45%]` configuration.
Three panels that cannot be collapsed, reordered, or given to the user.

### 1.7 What is already right

Not everything needs rebuilding. These are keepers:

- the **slot contract** (`CadWorkbenchSlots` / `CadWorkbenchSlotContext`)
  — the seam every zone extraction rides;
- the **engine/DOM separation** — `workbench-engine.tsx` holds the state,
  no zone needs to re-derive anything;
- the **DRO band** under the viewport (`data-testid="viewport-dro"`) and
  the **settle lamp** — honest, token-correct, already instrument-voiced;
- `CadViewportViewTools` — already all `ToolButton`, already an overlay
  layer with correct `pointer-events` discipline;
- `FeatureTimelineChips` / `FeatureTimelineSummary` — already split so
  the counter escapes the scroll container;
- the **density tokens** in `packages/ui/src/styles/cockpit.css`
  (`--appbar-h`, `--row-h`, `--tool-h`, `--control-h`, `--header-h`,
  `--rail-w`, `--rail-w-icon: 2.75rem`, `--pad-panel`, `--gap*`).
  Note `--rail-w-icon` exists but is used by nothing that is a rail —
  its only consumer is `viewport-view-tools.tsx`, which sizes its
  overlay panel at `calc(var(--rail-w-icon)*4)`. It is free to become
  the collapsed-rail width this plan needs.

---

## 2. The zone map

Five zones. Every pixel of the cockpit belongs to exactly one. A zone is
a COMPONENT with a named file, not a region of `complete-workbench.tsx`.

```
┌──────────────────────────────────────────────────────────────┐
│ TOP  · WorkbenchToolStrip      (icon clusters, flyouts)      │ --appbar-h
├──────────────────────────────────────────────────────────────┤
│ TOP' · WorkbenchToolOptions    (armed tool's options)        │ --tool-h (conditional)
├────────────┬────────────────────────────────┬────────────────┤
│            │                                │                │
│ LEFT       │ CENTER · WorkbenchViewport     │ RIGHT          │
│ Workbench  │          + HUD overlay layer   │ WorkbenchInsp- │
│ ModelRail  │          + DRO band            │ ectorRail      │
│            │                                │                │
│ --rail-w   │            flex-1              │  resizable     │
├────────────┴────────────────────────────────┴────────────────┤
│ BOTTOM · WorkbenchTimelineBand                               │ h-9
├──────────────────────────────────────────────────────────────┤
│ BOTTOM · WorkbenchStatusBand                                 │ CadStatusBar
└──────────────────────────────────────────────────────────────┘
```

### TOP — the icon tool strip

**Owns:** command/tool clusters. Every verb the document can execute.

|                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fills it today** | an inline `<div>` in `complete-workbench.tsx` (≈ L2603–3130) + `CadToolbar`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Made of today**  | `Button variant="outline" size="xs"` × 19 text verbs, a pill-wrapped `CadToolbar` of 4 text tools, hand-rolled `role="group"` divs, `h-5 w-px bg-rule` dividers, and three tiers of `max-*:hidden`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Must become**    | `WorkbenchToolStrip` — a single `--appbar-h` strip of `ToolGroup`s whose members are **icon-only `ToolButton`s** (`size="icon"`, `aria-label` carries the name, `title` carries the description, `aria-keyshortcuts` the key). Verb FAMILIES collapse into one strip button with a flyout. The families, derived from the 19 verbs actually present: **Sketch** (Sketch, Sketch on face) · **Create** (Sweep, Loft, Helix) · **Modify** (Hole, Hole spec, Thread, Draft, Rib, Scale, Thicken, Split) · **Pattern** (Pattern, Pattern path, Mirror) · **Boolean** · **Transform** (Move body) · **Datum** · **Select/Measure** (the 4 `CadToolbar` tools). Extrude and Revolve are deliberately absent — they live in sketch mode's strip, and the map keeps them there. Nothing is hidden by viewport width: a family is one button at every width, so the hard-coded `1799px` breakpoint dies. The document plate moves OUT of this strip (it is status, → BOTTOM) and the drawer toggles become rail-collapse toggles owned by LEFT/RIGHT. |
| **Zone also owns** | the overflow rule: when clusters exceed the strip, the LAST cluster becomes a "more" flyout — never a hidden control.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**TOP′ — the tool-options bar.** A second, conditional strip directly
under the tool strip, `--tool-h` tall, present only while a tool is
armed, carrying that tool's options (extrude: direction/symmetric/draft;
line: construction/length-lock; pattern: count/spacing). Today these
options live in modal Formedible dialogs; the options bar is where a
parametric cockpit puts them. **It does not exist yet.**

### LEFT — the feature/model tree

**Owns:** the document's structure. What the model IS.

|                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fills it today** | an inline `<div className="absolute inset-y-0 left-0 … w-(--rail-w) … xl:static">` wrapping `CadModelTree` + `WorkbenchMeasurementSection`                                                                                                                                                                                                                                                                                                                                                              |
| **Made of today**  | a hand-rolled drawer div (translate/visibility transition), a 1293-line `CadModelTree` that renders its own containers and uses no `Panel`, and the measurement section (which is MEASUREMENT, not structure — it is in the wrong zone)                                                                                                                                                                                                                                                                 |
| **Must become**    | `WorkbenchModelRail` — a `Panel flush` of stacked `PanelSection`s: **Origin/Datums**, **Sketches**, **Features** (the real feature tree with rollback), **Bodies**, **Appearances**. One scroll, collapsible sections, a collapse-to-`--rail-w-icon` state. `CadModelTree` is restructured to render AS `PanelSection` rows (`--row-h`, `data-selected`, signal inline-start edge) rather than owning its own chrome. `WorkbenchMeasurementSection` MOVES to RIGHT (it is a property of the selection). |

### RIGHT — the inspector

**Owns:** properties, parameters, configuration, measurement — everything
about the CURRENT selection or the armed tool.

|                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Fills it today** | `WorkbenchRightSidebar` (`right-sidebar.tsx`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Made of today**  | legacy `bg-card` / `shadow-2xl` / `bg-primary/30`, a 2-way segmented switch (Panels ⇄ Agent chat), and three panels split by `max-h-[55%]` / `flex-1` / `max-h-[45%]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Must become**    | `WorkbenchInspectorRail` — a `Panel flush` on cockpit tokens whose body is a stack of collapsible `PanelSection`s: **Selection** (property panel), **Measurement** (moved from LEFT), **Parameters**, **Configurations**. Percentage caps are replaced by per-section collapse + natural flow. The agent-chat switch stays (it is a real second view) but becomes `ToolGroup` + `ToolButton` with `aria-pressed`, and the resize handle keeps its separator a11y pattern on `--focus`/`--signal` tokens. When a tool is armed, the Selection section is replaced by the tool's full parameter form — the inspector, not a modal, is where a feature is dialled in. |

### BOTTOM — timeline + status

**Owns:** time and state. Where the document IS in its history, and
whether the machine agrees with it.

|                    |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fills it today** | the `h-9` timeline div (`data-testid="complete-feature-timeline"`) + the settle-lamp wrapper + `CadStatusBar`                                                                                                                                                                                                                                                                                                                    |
| **Made of today**  | `FeatureTimelineChips` in a snap-scrolling masked `@container`, `FeatureTimelineSummary` outside the scroll, then a separate relative div that absolutely positions the settle lamp over `CadStatusBar`'s left padding (`[&_[data-slot='cad-status-bar']]:pl-9` — a selector reaching into another component's internals)                                                                                                        |
| **Must become**    | `WorkbenchTimelineBand` and `WorkbenchStatusBand`. The timeline keeps its chips and scroll discipline and GAINS the rollback scrubber as a first-class track. The status band absorbs the settle lamp as a real `StatusDot` slot on `CadStatusBar` — the `pl-9` reach-in is deleted — and absorbs the **document plate** evicted from TOP (scene kind, extents, feature count: all status, all already in the DRO's vocabulary). |

### CENTER — viewport + HUD

**Owns:** the geometry, and only overlays that describe it.

|                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fills it today** | `defaultViewport` in `complete-workbench.tsx` (≈ L1965–2300): `CadViewport` + its `overlay` render prop + the DRO band                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Made of today**  | R3F canvas, and inside the overlay: the import-preview chip, the error alert, `CadViewportViewTools` (bottom-right), the curve/datum overlays, the sketch hint card. Below it, the DRO band (`h-7 bg-well font-mono`)                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Must become**    | `WorkbenchViewport` + an explicit `ViewportHud` layer with NAMED corners — `hud.topLeft` (mode/preview chips), `hud.topRight` (alerts), `hud.bottomRight` (`CadViewportViewTools` + view cube), `hud.bottomLeft` (snap/grid state). Every HUD item is `pointer-events-none` by default and opts in, as the view tools already do. The DRO band stays as the viewport's own bottom edge — it belongs to CENTER, not to BOTTOM, because it reads the camera and the picked entity. In SKETCH mode the same `WorkbenchViewport` hosts `CadSketchCanvas` **filling the frame** instead of sitting centred in a flex-wrap stage. |

### Zone invariants

1. A zone component owns its own surface rung, rule, and width/height
   token. No zone sets another zone's metrics.
2. A zone never reaches into a child component's DOM with a descendant
   selector. (The `pl-9` status-bar hack is the one existing violation
   and is scheduled for deletion.)
3. Every zone is still a `CadWorkbenchSlots` slot, so a host can replace
   it whole. Extraction must not narrow the slot contract.
4. No zone hides a control by viewport width. Density degrades by
   collapsing labels and folding into flyouts, never by `*:hidden`.
5. Both modes (model, sketch) render the SAME five zones. Mode changes
   zone CONTENTS, never the zone skeleton.

---

## 3. The gap list — what must be built

Nothing in this list exists in the repo today. Each is a new file.

| #   | Thing                                                                                                                                                                                                                                                                                                  | Where it goes                                                                                                          | Why it is needed                                                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **Tool icon map** — `toolId → LucideIcon` for the 4 model tools, the 36 sketch tools in `CAD_SKETCH_TOOLBAR_LABELS`, and the 19 model verbs, with label/description/shortcut beside the icon                                                                                                           | `packages/ui/src/components/cad/cad-tool-icons.ts`                                                                     | An icon strip cannot exist while the only tool metadata in the repo is `{label, tooltip}` strings in `CAD_TOOLBAR_LABELS` / `CAD_SKETCH_TOOLBAR_LABELS`. One frozen typed record, no `any`, exhaustive over the tool-id unions. |
| G2  | **`ToolFlyout`** — a tool-family primitive: one strip button showing the family's LAST-USED member, a corner tick marking it as a family, press-and-hold or chevron to open a popover list of members with icons + keycaps, arrow-key roving, Escape closes, selection re-arms and re-faces the button | `packages/ui/src/components/cockpit/tool-flyout.tsx`                                                                   | The only way 19 verbs plus the tool set fit a 40px strip. The repo has `Popover` but no flyout pattern and no tool-family concept at all.                                                                                       |
| G3  | **`ToolStrip`** — the strip container primitive: horizontal `ToolGroup` runs, rule dividers, overflow → "more" flyout, one keyboard model for the whole strip                                                                                                                                          | `packages/ui/src/components/cockpit/tool-strip.tsx`                                                                    | Today the container is an inline div and the dividers are `aria-hidden` spans copy-pasted twice.                                                                                                                                |
| G4  | **`ToolOptionsBar`** — the TOP′ strip: armed-tool options, rendered from a per-tool options descriptor, `--tool-h`, present only while armed                                                                                                                                                           | `packages/ui/src/components/cockpit/tool-options-bar.tsx` + `apps/web/src/cad-workbench/tool-options.ts` (descriptors) | Does not exist in any form. Today every option is a modal dialog.                                                                                                                                                               |
| G5  | **`RailSection`** — a collapsible `PanelSection` (disclosure state, chevron, persisted open/closed, count in the trailing slot)                                                                                                                                                                        | extend `packages/ui/src/components/cockpit/panel.tsx`                                                                  | `PanelSection` exists but has no disclosure, so neither rail can be organised into collapsible sections. Its only consumer today is the design gallery, so extending it breaks nothing.                                         |
| G6  | **Rail collapse** — a `--rail-w-icon` collapsed state for LEFT and RIGHT with a persisted toggle                                                                                                                                                                                                       | `apps/web/src/cad-workbench/rail-state.ts` + the two rail components                                                   | `--rail-w-icon: 2.75rem` is already declared in `cockpit.css` with no consumer.                                                                                                                                                 |
| G7  | **`ViewportHud`** — the named-corner overlay layer                                                                                                                                                                                                                                                     | `packages/ui/src/components/cad/cad-viewport-hud.tsx`                                                                  | `CadViewport` takes one opaque `overlay` ReactNode; the complete workbench passes a 300-line fragment of absolutely-positioned siblings.                                                                                        |
| G8  | **Five zone components** — `WorkbenchToolStrip`, `WorkbenchModelRail`, `WorkbenchInspectorRail`, `WorkbenchViewport`, `WorkbenchTimelineBand` / `WorkbenchStatusBand`                                                                                                                                  | `apps/web/src/cad-workbench/zones/*.tsx`                                                                               | The zones are currently inline regions of a 3594-line file.                                                                                                                                                                     |
| G9  | **`Button` on density tokens** — `size` variants currently hardcode `h-8` / `h-6` / `h-7` / `size-6` etc., violating DESIGN.md's "no component may hardcode a height"                                                                                                                                  | `packages/ui/src/components/button.tsx`                                                                                | Named in the brief as in scope: the shadcn primitives themselves. Must map to `--control-h`, `--control-h-sm`, `--tool-h`.                                                                                                      |
| G10 | **Sketch toolbar onto cockpit primitives** — `CadSketchToolbar` is the last tool surface still on raw `Button` + `border-border bg-background` + text labels                                                                                                                                           | `packages/ui/src/components/cad/cad-sketch-toolbar.tsx`                                                                | It is the sketch mode's TOP zone and must share one dialect with the model mode's.                                                                                                                                              |

---

## 4. The step plan for dispatches 2–4

Phase boundaries are hard stops. Each step ends with `pnpm run verify`
green and one or more commits on `redesign/pro-cad-v2`.

### Standing constraints for every step

- **Never touch** `apps/web/e2e-session/**`, `apps/web/e2e*/**`, or any
  playwright config.
- **Presentation-surface guard.** `pnpm test` runs
  `apps/web/src/design/presentation-surface/manifest.test.ts` against the
  committed 221KB `manifest.snapshot.json`. Any change to an `aria-*`,
  `role`, or `data-*` declaration fails it. Each step that deliberately
  changes the surface must run `pnpm run surface:check`, then
  `pnpm run surface:manifest`, and commit the snapshot diff **in the same
  commit as the change that caused it** — never as a drive-by.
- **Preserve every `data-testid` and `data-*` machine attribute** that
  the session harness reads. Moving a control between zones keeps its
  testid; only its parent changes.
- **Legacy fixtures are frozen**: `CadWorkbenchPage.tsx`,
  `CadChainWorkbenchPage.tsx`, and the analysis/assembly/sim/interference
  workbenches keep their pinned DOM. If a shared component they import
  changes shape, their call sites get a compatibility prop — they do not
  get redesigned.
- `--rail-w`, `--appbar-h`, `--tool-h`, `--header-h`, `--row-h` are the
  only sources of those metrics. No new hardcoded height anywhere.

### STEP 2 — the primitives, and the top zone

The strip is first because it is the biggest defect and because it is
the only zone that needs new primitives.

| Order | File                                                                                                                     | Action                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2.1   | `packages/ui/src/components/button.tsx`                                                                                  | G9: map every `size` variant onto `--control-h` / `--control-h-sm` / `--tool-h`; delete hardcoded `h-*`/`size-*`.                                            |
| 2.2   | `packages/ui/src/components/cockpit/tool-strip.tsx` (new)                                                                | G3: `ToolStrip` + overflow rule. Unit test beside it.                                                                                                        |
| 2.3   | `packages/ui/src/components/cockpit/tool-flyout.tsx` (new)                                                               | G2: `ToolFlyout` on `Popover`, roving focus, last-used face, `aria-haspopup`/`aria-expanded`. Unit test.                                                     |
| 2.4   | `packages/ui/src/components/cad/cad-tool-icons.ts` (new)                                                                 | G1: the frozen icon/label/shortcut record + the family grouping data.                                                                                        |
| 2.5   | `packages/ui/src/components/cad/cad-toolbar.tsx`                                                                         | Icon-only `ToolButton`s, drop the pill container (`bg-card/60 rounded-md border p-0.5`), render through `ToolStrip`.                                         |
| 2.6   | `apps/web/src/cad-workbench/zones/workbench-tool-strip.tsx` (new)                                                        | G8: the TOP zone — the 19 verbs regrouped into the 8 families, each a `ToolFlyout`. Delete every `max-xl:hidden` / `max-2xl:hidden` / `max-[1799px]:hidden`. |
| 2.7   | `apps/web/src/cad-workbench/complete-workbench.tsx`                                                                      | Replace the inline command row (≈ L2603–3130) with `<WorkbenchToolStrip …>`; move the document plate out (park it in the status band in 2.8).                |
| 2.8   | `apps/web/src/cad-workbench/zones/workbench-status-band.tsx` (new) + `packages/ui/src/components/cad/cad-status-bar.tsx` | Absorb the settle lamp as a real `StatusDot` slot; delete the `[&_[data-slot='cad-status-bar']]:pl-9` reach-in; adopt the document plate.                    |
| 2.9   | surface                                                                                                                  | `pnpm run surface:check` → `pnpm run surface:manifest`, commit snapshot with the change.                                                                     |

**Step 2 ends when:** the cockpit's top edge is an icon strip with zero
width-conditional hiding, every verb reachable at 1280px, and
`pnpm run verify` green. Screenshot at 1280 / 1600 / 1920 before
reporting.

### STEP 3 — the rails

| Order | File                                                                  | Action                                                                                                                                                             |
| ----- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3.1   | `packages/ui/src/components/cockpit/panel.tsx`                        | G5: add disclosure to `PanelSection` (`collapsible`, `defaultOpen`, controlled `open`/`onOpenChange`, chevron, `aria-expanded`).                                   |
| 3.2   | `apps/web/src/cad-workbench/rail-state.ts` (new)                      | G6: collapsed/expanded + per-section disclosure, persisted; pure, node-tested (the `right-sidebar-size.ts` precedent).                                             |
| 3.3   | `apps/web/src/cad-workbench/zones/workbench-model-rail.tsx` (new)     | G8/LEFT: `Panel flush` + collapsible sections; absorbs the inline drawer div; collapse to `--rail-w-icon`.                                                         |
| 3.4   | `packages/ui/src/components/cad/cad-model-tree.tsx`                   | Render as rows inside a host-owned section; stop owning chrome. Keep every testid and `data-*`.                                                                    |
| 3.5   | `apps/web/src/cad-workbench/zones/workbench-inspector-rail.tsx` (new) | G8/RIGHT: rewrite of `right-sidebar.tsx` onto cockpit tokens; `%` caps → collapsible sections; keep the resize separator and its a11y pattern; keep the chat view. |
| 3.6   | `apps/web/src/cad-workbench/measurement-section.tsx`                  | Move from LEFT to RIGHT as a section of the inspector rail.                                                                                                        |
| 3.7   | `apps/web/src/cad-workbench/complete-workbench.tsx`                   | Swap both inline dock divs for the two rail zones.                                                                                                                 |
| 3.8   | surface                                                               | `surface:check` → `surface:manifest`, commit together.                                                                                                             |

**Step 3 ends when:** both rails are `Panel`-built, collapsible,
token-clean, with no legacy `bg-card`/`shadow-2xl`/`border-border` left
in the cockpit, and `pnpm run verify` green.

### STEP 4 — the center, the options bar, and sketch mode

| Order | File                                                                 | Action                                                                                                                                                                                                                                                     |
| ----- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1   | `packages/ui/src/components/cad/cad-viewport-hud.tsx` (new)          | G7: named-corner HUD layer; `CadViewport` gains a typed `hud` prop beside the existing `overlay` (which stays, for the fixtures).                                                                                                                          |
| 4.2   | `apps/web/src/cad-workbench/zones/workbench-viewport.tsx` (new)      | G8/CENTER: extract `defaultViewport`; route the chips/alerts/view-tools/sketch-hint into HUD corners; DRO band stays as its bottom edge.                                                                                                                   |
| 4.3   | `apps/web/src/cad-workbench/tool-options.ts` (new)                   | G4 data: per-tool options descriptors, typed, exhaustive, node-tested.                                                                                                                                                                                     |
| 4.4   | `packages/ui/src/components/cockpit/tool-options-bar.tsx` (new)      | G4: the TOP′ strip; renders a descriptor; `--tool-h`; only while armed.                                                                                                                                                                                    |
| 4.5   | `apps/web/src/cad-workbench/complete-workbench.tsx`                  | Mount TOP′ under TOP; route the armed tool's options there; the inspector rail shows the armed tool's full form.                                                                                                                                           |
| 4.6   | `packages/ui/src/components/cad/cad-sketch-toolbar.tsx`              | G10: icon-only `ToolButton`s via the G1 map, `ToolStrip` + family flyouts for the 3 groups, cockpit tokens.                                                                                                                                                |
| 4.7   | `apps/web/src/cad-workbench/SketchMode.tsx`                          | Rebuild on the five zones: its command row → `WorkbenchToolStrip` content, its canvas → `WorkbenchViewport` filling the frame (not `flex-wrap justify-center`), its inspector → `WorkbenchInspectorRail` section, its status line → `WorkbenchStatusBand`. |
| 4.8   | `apps/web/src/cad-workbench/zones/workbench-timeline-band.tsx` (new) | G8/BOTTOM: extract the timeline band; rollback as a first-class track.                                                                                                                                                                                     |
| 4.9   | surface                                                              | `surface:check` → `surface:manifest`, commit together.                                                                                                                                                                                                     |

**Step 4 ends when:** model mode and sketch mode render the same five
zones, the armed tool has an options bar, no `bg-card/50` or
`text-[11px]` survives in the workbench, and `pnpm run verify` green.

### What step 4 deliberately leaves

Dockable/rearrangeable panels, multi-viewport layouts, and a saved
workspace-layout system are explicitly NOT in 2–4. The zone map above is
the precondition for them; attempting them before the zones are real
components is how the first pass became polish.
