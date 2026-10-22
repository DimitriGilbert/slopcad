/**
 * LEFT — `WorkbenchModelRail`, the dock that says what the model IS.
 *
 * ## What this replaces
 *
 * An inline `<div>` in `complete-workbench.tsx` that was a drawer
 * pretending to be a rail: `absolute inset-y-0 left-0 z-30 … w-(--rail-w)
 * … shadow-overlay transition-[transform,visibility] … xl:static` with
 * `invisible -translate-x-full xl:visible xl:translate-x-0`, a `xl:hidden`
 * scrim over the whole workspace, and a `xl:hidden` toggle living three
 * zones away in the tool strip. Below 1280px the rail was off-canvas and
 * the toggle existed; above it the rail was inline and the toggle
 * vanished. A control that exists only at some widths is the defect
 * LAYOUT.md's zone invariant 4 names.
 *
 * Inside it, two components owned chrome that is the rail's job:
 * `CadModelTree` drew its own bordered card and its own "MODEL TREE" name
 * band, and `WorkbenchMeasurementSection` sat under it — measurement in
 * the structure zone, which LAYOUT.md 3.6 moves to the inspector.
 *
 * ## What it is now
 *
 * A real `Panel flush` — the first cockpit surface ever to consume the
 * cockpit's own enclosure primitives, which the audit found had ZERO
 * consumers in the workbench — stacking three collapsible
 * `PanelSection`s over one scroll:
 *
 * - **Sketches** — the saved profile pool every create verb draws from,
 * - **Datums** — the planes, axes, points and systems features anchor to,
 * - **Features** — the feature/body tree, rendered `chrome="flush"` so
 *   the section's own name strip is the only one.
 *
 * and ONE collapse state: expanded at `--rail-w`, collapsed at
 * `--rail-w-icon` (the token that has been declared with no rail
 * consumer since the density pass). Collapsed is a real icon rail — the
 * toggle and one button per section, each of which expands the rail and
 * discloses its section — never a hidden or off-canvas rail. The rail is
 * in the flex flow at every width; nothing is `invisible`, nothing is
 * translated, and there is no scrim.
 *
 * The dock's `data-testid` ("workbench-tree-dock") and the toggle's
 * ("workbench-toggle-tree", moved here from the tool strip, which is
 * where LAYOUT.md's TOP table says it belongs) are unchanged, as is the
 * toggle's accessible name.
 */

import type { ReactElement, ReactNode } from "react";
import {
  Grid2x2,
  ListTree,
  PanelLeftClose,
  PanelLeftOpen,
  PencilRuler,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  Panel,
  PanelBody,
  PanelHeader,
  PanelSection,
} from "@slopcad/ui/components/cockpit/panel";
import { PropertyRow } from "@slopcad/ui/components/cockpit/property-row";
import {
  ToolButton,
  ToolGroup,
} from "@slopcad/ui/components/cockpit/tool-button";
import type { WorkbenchRailSectionId } from "../rail-state";

/** A saved sketch, as the rail lists it. */
export interface WorkbenchModelRailSketch {
  readonly id: string;
  readonly name: string;
}

/** A datum record, as the rail lists it: name plus its resolved kind. */
export interface WorkbenchModelRailDatum {
  readonly id: string;
  readonly name: string;
  /** The parsed `datumType` ("plane", "axis", …) or `null` if unreadable. */
  readonly kind: string | null;
}

/** Props of {@link WorkbenchModelRail}. */
export interface WorkbenchModelRailProps {
  /** The `modelTree` slot's node — the Features section's content. */
  readonly modelTree: ReactNode;
  /** The document's saved sketches, in document order. */
  readonly sketches: readonly WorkbenchModelRailSketch[];
  /** The document's datum records, in document order. */
  readonly datums: readonly WorkbenchModelRailDatum[];
  /** Whether the rail is collapsed to the icon width. */
  readonly collapsed: boolean;
  /** Flips the collapse. */
  readonly onToggleCollapsed: () => void;
  /** Whether one of the rail's sections is disclosed. */
  readonly isSectionOpen: (section: WorkbenchRailSectionId) => boolean;
  /** Sets one section's disclosure. */
  readonly onSectionOpenChange: (
    section: WorkbenchRailSectionId,
    open: boolean,
  ) => void;
}

/** The rail's three sections, in rail order, with their icon-rail marks. */
const SECTIONS: readonly {
  readonly id: WorkbenchRailSectionId;
  readonly title: string;
  readonly icon: LucideIcon;
}[] = [
  { icon: PencilRuler, id: "model-sketches", title: "Sketches" },
  { icon: Grid2x2, id: "model-datums", title: "Datums" },
  { icon: ListTree, id: "model-features", title: "Features" },
];

/**
 * The dock toggle, identical in both states so its testid never moves.
 * In the 26px name strip it is a `--control-h` square (nothing inside a
 * panel header may be taller than the header); in the icon rail it is a
 * full `--tool-h` button, which is what that rail is sized for.
 */
function CollapseToggle({
  collapsed,
  onToggle,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}): ReactElement {
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <ToolButton
      aria-expanded={!collapsed}
      aria-label="Toggle model tree"
      className={collapsed ? undefined : "w-(--control-h) justify-center px-0"}
      data-testid="workbench-toggle-tree"
      onClick={onToggle}
      size={collapsed ? "icon" : "sm"}
      title={
        collapsed
          ? "Expand the model rail to its full width."
          : "Collapse the model rail to its icon width."
      }
    >
      <Icon aria-hidden="true" />
    </ToolButton>
  );
}

/** The LEFT zone: the document's structure, as one panel. */
export function WorkbenchModelRail({
  collapsed,
  datums,
  isSectionOpen,
  modelTree,
  onSectionOpenChange,
  onToggleCollapsed,
  sketches,
}: WorkbenchModelRailProps): ReactElement {
  return (
    <Panel
      className={`shrink-0 border-r border-rule ${
        collapsed ? "w-(--rail-w-icon)" : "w-(--rail-w)"
      }`}
      data-collapsed={collapsed ? "true" : "false"}
      data-testid="workbench-tree-dock"
      data-zone="left"
      flush
    >
      {collapsed ? (
        /* The icon rail. Every control here does something real: the
           toggle expands the rail, and a section mark expands it AND
           discloses that section, so the collapsed rail is a way INTO
           the content, not a decorative gutter. */
        <ToolGroup
          className="flex-col items-stretch gap-(--gap-tight) p-(--gap-tight)"
          label="Model rail"
          separated={false}
        >
          <CollapseToggle collapsed onToggle={onToggleCollapsed} />
          {/* The rule the expanded rail's name strip draws: above it the
              rail's own state, below it the document's content. */}
          <span aria-hidden="true" className="my-(--gap-tight) h-px bg-rule" />
          {SECTIONS.map(({ icon: Icon, id, title }) => (
            <ToolButton
              aria-label={title}
              key={id}
              onClick={() => {
                onSectionOpenChange(id, true);
                onToggleCollapsed();
              }}
              size="icon"
              title={`Open ${title} in the model rail.`}
            >
              <Icon aria-hidden="true" />
            </ToolButton>
          ))}
        </ToolGroup>
      ) : (
        <>
          <PanelHeader title="Model">
            <span className="ml-auto flex shrink-0 items-center">
              <CollapseToggle collapsed={false} onToggle={onToggleCollapsed} />
            </span>
          </PanelHeader>
          <PanelBody>
            <PanelSection
              collapsible
              id="rail-model-sketches"
              onOpenChange={(open) => {
                onSectionOpenChange("model-sketches", open);
              }}
              open={isSectionOpen("model-sketches")}
              title="Sketches"
              trailing={String(sketches.length)}
            >
              {sketches.length === 0 ? (
                <p className="px-(--pad-row) py-(--gap) text-ui text-ink-dim">
                  no saved sketches yet
                </p>
              ) : (
                sketches.map((sketch) => (
                  <PropertyRow key={sketch.id} label={sketch.name}>
                    {sketch.id}
                  </PropertyRow>
                ))
              )}
            </PanelSection>
            <PanelSection
              collapsible
              id="rail-model-datums"
              onOpenChange={(open) => {
                onSectionOpenChange("model-datums", open);
              }}
              open={isSectionOpen("model-datums")}
              title="Datums"
              trailing={String(datums.length)}
            >
              {datums.length === 0 ? (
                <p className="px-(--pad-row) py-(--gap) text-ui text-ink-dim">
                  no datum geometry yet
                </p>
              ) : (
                datums.map((datum) => (
                  <PropertyRow key={datum.id} label={datum.name}>
                    {datum.kind ?? "unreadable"}
                  </PropertyRow>
                ))
              )}
            </PanelSection>
            <PanelSection
              collapsible
              id="rail-model-features"
              onOpenChange={(open) => {
                onSectionOpenChange("model-features", open);
              }}
              open={isSectionOpen("model-features")}
              title="Features"
            >
              {modelTree}
            </PanelSection>
          </PanelBody>
        </>
      )}
    </Panel>
  );
}
