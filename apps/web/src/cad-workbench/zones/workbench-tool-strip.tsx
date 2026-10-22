/**
 * TOP — `WorkbenchToolStrip`, the cockpit's icon tool strip.
 *
 * This zone replaces the single worst structural defect in the product: a
 * ~530-line inline region of `complete-workbench.tsx` that held nineteen
 * text-label verbs in one `--appbar-h` row and, because they did not fit,
 * held itself together with THREE tiers of width-conditional hiding
 * (`max-xl:hidden` on six verbs, `max-2xl:hidden` on five,
 * `max-[1799px]:hidden` on seven — a hard-coded breakpoint named after a
 * measurement of the row itself). Below those widths eleven verbs were
 * reachable only through the command palette.
 *
 * The strip is the answer the layout law prescribes:
 *
 * - every verb is an ICON control whose `aria-label` carries the name the
 *   text button carried, so no accessible name changed;
 * - verb FAMILIES collapse into one `ToolFlyout` slot each — Sketch,
 *   Create, Modify, Pattern — so the strip's width no longer grows with
 *   the feature set;
 * - a family's face is the member a harness and an operator reach for
 *   most (Hole, Sketch), carrying that member's `data-testid` and running
 *   it on a direct press;
 * - NOTHING is hidden by viewport width. There is not one `max-*:hidden`
 *   in this file. A verb that cannot run renders disabled with the reason
 *   in its `title`, exactly as before, at every width;
 * - the five SHEET verbs, which never fitted the old row at any width and
 *   lived in the command menu alone, finally have a strip home: the
 *   Surface family in the strip's pinned trailing cluster.
 *
 * ## What this zone deliberately does not own
 *
 * The document plate moved OUT — it is status, and it now lives in
 * `WorkbenchStatusBand`. The two dock toggles moved OUT in step 3 — they
 * are rail state, and `WorkbenchModelRail` / `WorkbenchInspectorRail`
 * each own their own, keeping the `workbench-toggle-tree` and
 * `workbench-toggle-panels` testids and accessible names. With them went
 * the last `xl:hidden` in this file: there is now no class in this zone
 * that depends on the viewport's width.
 *
 * ## One-member families
 *
 * Boolean, Move body and Datum are listed as families by the layout map
 * but have one member each. A one-member flyout is a chevron that opens a
 * list of one, so they render as plain icon buttons in a single Bodies
 * cluster instead — the family mechanism exists to fold width, and there
 * is no width to fold.
 */

import { useMemo } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";
import { CAD_MODEL_COMMAND_ICONS } from "@slopcad/ui/components/cad/cad-tool-icons";
import type { CadModelCommandId } from "@slopcad/ui/components/cad/cad-tool-icons";
import {
  ToolButton,
  ToolGroup,
} from "@slopcad/ui/components/cockpit/tool-button";
import { ToolFlyout } from "@slopcad/ui/components/cockpit/tool-flyout";
import type { ToolFlyoutItem } from "@slopcad/ui/components/cockpit/tool-flyout";
import { ToolStrip } from "@slopcad/ui/components/cockpit/tool-strip";

/** The feature dialogs the strip can open (a subset of the host's kinds). */
export type WorkbenchStripDialogKind =
  | "surface-create"
  | "surface-trim"
  | "surface-thicken"
  | "surface-knit"
  | "surface-offset"
  | "sweep"
  | "loft"
  | "helix"
  | "thread"
  | "draft"
  | "rib"
  | "scale"
  | "thicken"
  | "split"
  | "hole"
  | "pattern"
  | "patternPath"
  | "mirror"
  | "boolean"
  | "moveBody"
  | "datum";

/**
 * The document facts every verb's enablement is derived from. One object
 * instead of nineteen `disabled` props: the strip states each verb's
 * precondition itself, in the title, where the old row did.
 */
export interface WorkbenchStripAvailability {
  /** An extrusion the QUICK hole verb can cut (the engine's hole base). */
  readonly hasQuickHoleBase: boolean;
  /** An extrusion exists at all (the solid every modify verb needs). */
  readonly hasExtrudeBase: boolean;
  /** At least two saved sketches (sweep and loft author from the pool). */
  readonly canAuthorSketchFeatures: boolean;
  /** How many sketches the document has saved. */
  readonly sketchCount: number;
  /** How many datum planes the document has. */
  readonly datumPlaneCount: number;
  /** How many feature-produced bodies exist (a boolean needs two). */
  readonly bodyCount: number;
  /** How many sheet bodies exist (the surface family's input). */
  readonly sheetCount: number;
  /** Whether a FACE is selected (sketch-on-face anchors to one). */
  readonly hasFaceSelection: boolean;
}

/** The strip's file-exchange cluster, absent when the host wires no IO. */
export interface WorkbenchStripIo {
  /** Opens the import dialog. */
  readonly onImport: () => void;
  /** Opens the export dialog. */
  readonly onExport: () => void;
  /** Whether the scene has settled into something exportable. */
  readonly canExport: boolean;
  /** The dialogs' `finalFocus` targets. */
  readonly importTriggerRef: RefObject<HTMLButtonElement | null>;
  readonly exportTriggerRef: RefObject<HTMLButtonElement | null>;
}

/** Props of {@link WorkbenchToolStrip}. */
export interface WorkbenchToolStripProps {
  /** The tool cluster — the `toolbar` slot's node. */
  readonly toolbar: ReactNode;
  /** The command menu — the `commandMenu` slot's node (trigger + palette). */
  readonly commandMenu: ReactNode;
  /** The document facts the verbs' enablement reads. */
  readonly availability: WorkbenchStripAvailability;
  /** Opens one feature dialog. */
  readonly onFeatureDialog: (kind: WorkbenchStripDialogKind) => void;
  /** Runs the quick hole verb (no dialog — the engine's direct cut). */
  readonly onQuickHole: () => void;
  /** Boots the sketch editor on the selected face. */
  readonly onSketchOnFace: () => void;
  /** Enters the sketch workspace. */
  readonly onEnterSketch: () => void;
  /** History state and steps. */
  readonly canUndo: boolean;
  readonly onUndo: () => void;
  readonly canRedo: boolean;
  readonly onRedo: () => void;
  /** The file-exchange cluster, or `null` when the host wires no adapters. */
  readonly io: WorkbenchStripIo | null;
  /** Hidden (never unmounted) while the sketch editor owns the frame. */
  readonly hidden: boolean;
}

/**
 * One verb of a family: the icon map supplies the mark and the name, the
 * caller supplies the live precondition and what it does.
 */
function verb(
  id: CadModelCommandId,
  options: {
    readonly enabled: boolean;
    readonly ready: string;
    readonly blocked: string;
    readonly run: () => void;
    readonly testId?: string;
  },
): ToolFlyoutItem {
  const { icon, label } = CAD_MODEL_COMMAND_ICONS[id];
  return {
    id,
    label,
    icon,
    description: options.enabled ? options.ready : options.blocked,
    disabled: !options.enabled,
    testId: options.testId,
    onSelect: options.run,
  };
}

/** The TOP zone: one icon strip, no width-conditional hiding anywhere. */
export function WorkbenchToolStrip({
  availability,
  canRedo,
  canUndo,
  commandMenu,
  hidden,
  io,
  onEnterSketch,
  onFeatureDialog,
  onQuickHole,
  onRedo,
  onSketchOnFace,
  onUndo,
  toolbar,
}: WorkbenchToolStripProps): ReactElement {
  const {
    bodyCount,
    canAuthorSketchFeatures,
    datumPlaneCount,
    hasExtrudeBase,
    hasFaceSelection,
    hasQuickHoleBase,
    sheetCount,
    sketchCount,
  } = availability;

  const families = useMemo(() => {
    const sketch: readonly ToolFlyoutItem[] = [
      verb("sketch", {
        enabled: true,
        ready: "Start a sketch: draw a profile, then extrude it into a solid.",
        blocked: "",
        run: onEnterSketch,
        testId: "complete-mode-toggle",
      }),
      verb("sketchOnFace", {
        enabled: hasFaceSelection,
        ready:
          "Sketch on the selected face: anchors a datum plane to it and boots the sketch editor there.",
        blocked:
          "Select a face in the viewport first; sketch-on-face anchors to it.",
        run: onSketchOnFace,
        testId: "complete-sketch-on-face",
      }),
    ];
    const create: readonly ToolFlyoutItem[] = [
      verb("sweep", {
        enabled: canAuthorSketchFeatures,
        ready: "Sweep a saved profile sketch along a saved path sketch.",
        blocked:
          "Save two sketches first (draw one, press Save, repeat); sweep picks its profile and path from the saved pool.",
        run: () => {
          onFeatureDialog("sweep");
        },
        testId: "complete-sweep",
      }),
      verb("loft", {
        enabled: canAuthorSketchFeatures,
        ready:
          "Loft two or more saved section sketches, in order, at their stations.",
        blocked:
          "Save two sketches first (draw one, press Save, repeat); loft picks its ordered sections from the saved pool.",
        run: () => {
          onFeatureDialog("loft");
        },
        testId: "complete-loft",
      }),
      verb("helix", {
        enabled: sketchCount >= 1,
        ready:
          "Sweep a saved profile sketch along an analytic helix: radius, pitch, turns, handedness, taper.",
        blocked:
          "Save a sketch first (draw one and press Save); the helix picks its meridian profile from the saved pool.",
        run: () => {
          onFeatureDialog("helix");
        },
        testId: "complete-helix",
      }),
    ];
    const modify: readonly ToolFlyoutItem[] = [
      verb("hole", {
        enabled: hasQuickHoleBase,
        ready:
          "Cut a hole into the latest extrusion; edit its five parameters in the panel.",
        blocked:
          "Sketch and extrude a profile first; a hole cuts an existing solid.",
        run: onQuickHole,
        testId: "complete-hole",
      }),
      verb("holeSpec", {
        enabled: hasExtrudeBase,
        ready:
          "Open the hole dialog: type, dimensions, thread spec, and positions (one feature, many holes).",
        blocked:
          "Sketch and extrude a profile first; a hole cuts an existing solid.",
        run: () => {
          onFeatureDialog("hole");
        },
        testId: "complete-hole-spec",
      }),
      verb("thread", {
        enabled: hasExtrudeBase,
        ready:
          "Cut an ISO metric thread on the latest extrusion: pick a designation, mode, and length.",
        blocked:
          "Sketch and extrude a profile first; a thread cuts an existing solid.",
        run: () => {
          onFeatureDialog("thread");
        },
        testId: "complete-thread",
      }),
      verb("draft", {
        enabled: sketchCount >= 1,
        ready:
          "Extrude a saved sketch with a draft taper: the walls lean by the angle away from the sketch plane.",
        blocked:
          "Save a sketch first (draw one and press Save); the draft picks its profile from the saved pool.",
        run: () => {
          onFeatureDialog("draft");
        },
        testId: "complete-draft",
      }),
      verb("rib", {
        enabled: sketchCount >= 1 && hasExtrudeBase,
        ready:
          "Union a rib: pick a saved cross-section sketch and a thickness; it extrudes symmetrically into the latest extrusion.",
        blocked:
          "Save a sketch and extrude a profile first; a rib needs a cross-section and a part to grow.",
        run: () => {
          onFeatureDialog("rib");
        },
        testId: "complete-rib",
      }),
      verb("scale", {
        enabled: hasExtrudeBase,
        ready:
          "Scale the latest extrusion by one uniform factor about the world origin.",
        blocked: "Extrude a profile first; a scale needs a solid.",
        run: () => {
          onFeatureDialog("scale");
        },
        testId: "complete-scale",
      }),
      verb("thicken", {
        enabled: hasExtrudeBase,
        ready:
          "Hollow the latest extrusion into a closed shell of uniform walls.",
        blocked: "Extrude a profile first; a thicken needs a solid.",
        run: () => {
          onFeatureDialog("thicken");
        },
        testId: "complete-thicken",
      }),
      verb("split", {
        enabled: datumPlaneCount >= 1 && hasExtrudeBase,
        ready: "Split the latest extrusion by a datum plane, keeping one side.",
        blocked:
          "Create a datum plane and extrude a profile first; a split needs both.",
        run: () => {
          onFeatureDialog("split");
        },
        testId: "complete-split",
      }),
    ];
    const pattern: readonly ToolFlyoutItem[] = [
      verb("pattern", {
        enabled: hasExtrudeBase,
        ready:
          "Pattern the latest extrusion: one leg per direction with its own count and spacing, instances skippable by ordinal.",
        blocked: "Extrude a profile first; a pattern needs a solid.",
        run: () => {
          onFeatureDialog("pattern");
        },
        testId: "complete-pattern",
      }),
      verb("patternPath", {
        enabled: sketchCount >= 1 && hasExtrudeBase,
        ready:
          "Repeat the latest extrusion along a saved path sketch at an arc-length spacing.",
        blocked:
          "Save a path sketch and extrude a profile first; a path pattern needs both.",
        run: () => {
          onFeatureDialog("patternPath");
        },
        testId: "complete-pattern-path",
      }),
      verb("mirror", {
        enabled: datumPlaneCount >= 1 && hasExtrudeBase,
        ready:
          "Mirror the latest extrusion about a datum plane, standalone or merged with the original.",
        blocked:
          "Create a datum plane and extrude a profile first; a mirror needs both.",
        run: () => {
          onFeatureDialog("mirror");
        },
        testId: "complete-mirror",
      }),
    ];
    // The sheet family: five verbs that never fitted the old row at ANY
    // width (~314px together, against a row already 1745px long) and so
    // lived in the command menu alone. The trailing cluster is their home.
    const surface: readonly ToolFlyoutItem[] = [
      verb("surfaceCreate", {
        enabled: datumPlaneCount >= 1,
        ready: "Create a base sheet on a datum plane.",
        blocked: "Create a datum plane first; a base sheet is built on one.",
        run: () => {
          onFeatureDialog("surface-create");
        },
      }),
      verb("surfaceTrim", {
        enabled: sheetCount >= 2,
        ready: "Trim one sheet by another, keeping the region you pick.",
        blocked: "Create two sheets first; a trim needs a target and a tool.",
        run: () => {
          onFeatureDialog("surface-trim");
        },
      }),
      verb("surfaceThicken", {
        enabled: sheetCount >= 1,
        ready: "Thicken a sheet into a solid of uniform walls.",
        blocked: "Create a sheet first; a thicken needs one.",
        run: () => {
          onFeatureDialog("surface-thicken");
        },
      }),
      verb("surfaceKnit", {
        enabled: sheetCount >= 2,
        ready: "Knit sheets into one shell within a stitch tolerance.",
        blocked: "Create two sheets first; a knit needs edges to sew.",
        run: () => {
          onFeatureDialog("surface-knit");
        },
      }),
      verb("surfaceOffset", {
        enabled: sheetCount >= 1,
        ready: "Offset a sheet along its own normals by a distance.",
        blocked: "Create a sheet first; an offset needs one.",
        run: () => {
          onFeatureDialog("surface-offset");
        },
      }),
    ];
    return { create, modify, pattern, sketch, surface };
  }, [
    canAuthorSketchFeatures,
    datumPlaneCount,
    hasExtrudeBase,
    hasFaceSelection,
    hasQuickHoleBase,
    onEnterSketch,
    onFeatureDialog,
    onQuickHole,
    onSketchOnFace,
    sheetCount,
    sketchCount,
  ]);

  const { icon: BooleanIcon, label: booleanLabel } =
    CAD_MODEL_COMMAND_ICONS.boolean;
  const { icon: MoveIcon, label: moveLabel } = CAD_MODEL_COMMAND_ICONS.moveBody;
  const { icon: DatumIcon, label: datumLabel } = CAD_MODEL_COMMAND_ICONS.datum;
  const { icon: ImportIcon } = CAD_MODEL_COMMAND_ICONS.import;
  const { icon: ExportIcon } = CAD_MODEL_COMMAND_ICONS.export;
  const { icon: UndoIcon } = CAD_MODEL_COMMAND_ICONS.undo;
  const { icon: RedoIcon } = CAD_MODEL_COMMAND_ICONS.redo;

  return (
    <ToolStrip
      className={hidden ? "hidden" : undefined}
      data-zone="top"
      label="Model tools"
      overflow={
        <ToolFlyout
          items={families.surface}
          label="Surface"
          triggerTestId="complete-surface-family"
        />
      }
    >
      {/* The slot's node, insulated: a host replacement never inherits the
          strip's first-cluster rule or loses its own. */}
      <div className="flex shrink-0 items-center">{toolbar}</div>
      <ToolGroup label="History">
        <ToolButton
          aria-label="Undo"
          disabled={!canUndo}
          onClick={onUndo}
          size="icon"
          title="Undo (the document history's cursor step)"
        >
          <UndoIcon aria-hidden="true" />
        </ToolButton>
        <ToolButton
          aria-label="Redo"
          disabled={!canRedo}
          onClick={onRedo}
          size="icon"
          title="Redo (the document history's cursor step)"
        >
          <RedoIcon aria-hidden="true" />
        </ToolButton>
      </ToolGroup>
      <ToolGroup label="Commands">{commandMenu}</ToolGroup>
      {io === null ? null : (
        <ToolGroup label="File">
          <ToolButton
            aria-label="Import"
            data-testid="complete-import"
            onClick={io.onImport}
            ref={io.importTriggerRef}
            size="icon"
            title="Import model files."
          >
            <ImportIcon aria-hidden="true" />
          </ToolButton>
          <ToolButton
            aria-label="Export"
            data-testid="complete-export"
            disabled={!io.canExport}
            onClick={io.onExport}
            ref={io.exportTriggerRef}
            size="icon"
            title={
              io.canExport
                ? "Export the settled model geometry."
                : "The scene settles first; nothing is exportable before that."
            }
          >
            <ExportIcon aria-hidden="true" />
          </ToolButton>
        </ToolGroup>
      )}
      <ToolGroup label="Sketch">
        {/* THE creation affordance: the one verb that adds geometry, and
            therefore the surface's single confirming action — the only
            place the signal colour appears on a momentary control. */}
        <ToolFlyout
          faceClassName="border-signal/60 hover:not-disabled:bg-signal/10 [&>svg]:text-signal"
          items={families.sketch}
          label="Sketch"
          triggerTestId="complete-sketch-family"
        />
      </ToolGroup>
      <ToolGroup label="Create">
        <ToolFlyout
          items={families.create}
          label="Create"
          triggerTestId="complete-create-family"
        />
      </ToolGroup>
      <ToolGroup label="Modify">
        <ToolFlyout
          items={families.modify}
          label="Modify"
          triggerTestId="complete-modify-family"
        />
      </ToolGroup>
      <ToolGroup label="Pattern">
        <ToolFlyout
          items={families.pattern}
          label="Pattern"
          triggerTestId="complete-pattern-family"
        />
      </ToolGroup>
      <ToolGroup label="Bodies">
        <ToolButton
          aria-label={booleanLabel}
          data-testid="complete-boolean"
          disabled={bodyCount < 2}
          onClick={() => {
            onFeatureDialog("boolean");
          }}
          size="icon"
          title={
            bodyCount >= 2
              ? "Combine two bodies: union, subtract, or intersect, with a keep-tool toggle."
              : "Extrude two profiles first; a boolean needs a target and a tool body."
          }
        >
          <BooleanIcon aria-hidden="true" />
        </ToolButton>
        <ToolButton
          aria-label={moveLabel}
          data-testid="complete-move-body"
          disabled={!hasExtrudeBase}
          onClick={() => {
            onFeatureDialog("moveBody");
          }}
          size="icon"
          title={
            hasExtrudeBase
              ? "Move the latest extrusion: translate it, optionally rotating about a world axis first."
              : "Extrude a profile first; a move needs a body."
          }
        >
          <MoveIcon aria-hidden="true" />
        </ToolButton>
        <ToolButton
          aria-label={datumLabel}
          data-testid="complete-datum"
          onClick={() => {
            onFeatureDialog("datum");
          }}
          size="icon"
          title="Create datum geometry: a plane, an axis, a point, or a coordinate system."
        >
          <DatumIcon aria-hidden="true" />
        </ToolButton>
      </ToolGroup>
    </ToolStrip>
  );
}
