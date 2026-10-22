/**
 * `CompleteCadWorkbench` (Phase 28): the COMPLETE workbench composition —
 * all eight surfaces the plan names, composed around one `CadProvider`
 * store and the shared workbench engine: the toolbar, the command menu,
 * the viewport, the model tree, the property panel, the parameter panel,
 * the history timeline, and the status bar, plus the import/export
 * dialogs and the measurement home.
 *
 * ## Component independence (the composition contract)
 *
 * The composition owns LAYOUT and DEFAULTS, never exclusivity: every
 * surface is a named SLOT in {@link CadWorkbenchSlots}, and a slot that is
 * a render function replaces that surface's default piece entirely —
 * receiving {@link CadWorkbenchSlotContext} (the public engine surfaces
 * and the IO adapter) so a replacement rebuilds the piece from the SAME
 * public state the default reads. Nothing reaches into internals: the
 * defaults are the `@slopcad/ui` CAD components (provider-driven where
 * they mirror the store), the extracted feature-timeline strip, and the
 * dialog primitives; every interaction rides the public hooks and the
 * command vocabulary exactly as the Phase 15 page's do.
 *
 * ## The command menu (the keyboard surface)
 *
 * The default menu lists every command the composition can honestly run —
 * tool arming through the store's `arm` op, undo/redo through the history
 * hook, selection clear through the selection hook, the sketch/hole
 * bridges, rollback clearing, and the import/export dialogs — each run
 * closing the palette first. Ctrl/Cmd+K opens it (the menu component's
 * own hotkey); the row trigger names that binding.
 *
 * ## The import preview (honest imported geometry)
 *
 * While an imported mesh preview is active the viewport renders the
 * IMPORTED projection under a truth-telling chip ("geometry only, not in
 * the document") with a one-click way back; the settle stamp it writes is
 * the import surface's own (`data-cad-imported-volume`), never the
 * document's — an imported mesh never masquerades as the parametric
 * model, and its frames count separately (`data-imported-frames`).
 *
 * ## Machine-readable surface (`#workbench-complete-root`)
 *
 * The engine-derived attributes (`data-selection`, `data-selection-key`,
 * `data-tool-*`, `data-history`, `data-command-log`,
 * `data-feature-timeline`, `data-rendered-frames`, `data-scene-*`,
 * `data-hole-diameter`, `data-sketch-mode`, `data-curves`), the dialog state
 * (`data-command-menu-open`, `data-export-dialog-open`,
 * `data-import-dialog-open`, `data-export-held`, `data-export-error`),
 * and the import surface (`data-import-source`, `data-import-triangles`,
 * `data-import-volume`, `data-import-detail`, `data-import-error`,
 * `data-cad-imported-volume`, `data-imported-frames`,
 * `data-viewport-showing`).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent, ReactElement, ReactNode } from "react";
import {
  serializeSelectionReference,
  selectionReferenceKey,
  MEASURE_TOOL_ID,
  ROTATE_TOOL_ID,
  SELECT_TOOL_ID,
} from "@slopcad/cad-react";
import {
  createBodyId,
  createConfigurationId,
  formatBoundsExtents,
  parseDatumPayload,
  withBodyAppearances,
} from "@slopcad/cad-core";
import { lightRigById } from "@slopcad/cad-r3f";
import { Command, PencilLine, X } from "lucide-react";
import {
  CadCommandMenu,
  type CadCommandDescriptor,
} from "@slopcad/ui/components/cad/cad-command-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@slopcad/ui/components/dialog";
import {
  CadExportDialog,
  CadImportDialog,
  type CadExportEntry,
  type CadExportFormatOption,
  type CadImportFormatOption,
  type CadImportHeldEntry,
  type CadImportOutcome,
} from "@slopcad/ui/components/cad/cad-io-dialog";
import { CadStatusBar } from "@slopcad/ui/components/cad/cad-status-bar";
import { CadToolbar } from "@slopcad/ui/components/cad/cad-toolbar";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import {
  KeyCap,
  ToolButton,
  ToolGroup,
} from "@slopcad/ui/components/cockpit/tool-button";
import { ToolOptionsBar } from "@slopcad/ui/components/cockpit/tool-options-bar";
import type { RenderCamera, RenderProjection } from "@slopcad/cad-core";
import type { FixtureSessionBackendId } from "../render-fixture/session-backend";
import type { CurveAuthoring } from "./curves";
import type { LoftSectionChoice } from "./loft";
import { clippingPlanesOf } from "@slopcad/cad-r3f";
import type { AgentToolsSurface } from "@slopcad/ui/agent/tools";
import {
  createAgentChatSessionSlot,
  useAgentChatSession,
} from "@slopcad/ui/agent/chat/session-slot";
import type { WorkbenchModelRailDatum } from "./zones/workbench-model-rail";

import { useWorkbenchWebMcpTools } from "../webmcp/workbench-tools";
import { executeWebMcpTool } from "../webmcp/registry";
import { completionJson } from "../render-fixture/fixture-session";
import { createAgentChatCommands } from "../agent/chat/chat-commands";
import { useAgentChatView } from "../agent/chat/view-state";
import { useWorkbenchRailState } from "./rail-state";
import {
  configurationPanelSlotDefault,
  modelTreeSlotDefault,
  parameterPanelSlotDefault,
  propertyPanelSlotDefault,
} from "./zones/rail-slot-defaults";
import { describeArmedTool } from "./tool-options";
import { WorkbenchInspectorRail } from "./zones/workbench-inspector-rail";
import { WorkbenchModelRail } from "./zones/workbench-model-rail";
import { WorkbenchStatusBand } from "./zones/workbench-status-band";
import {
  WorkbenchToolStrip,
  type WorkbenchStripAvailability,
  type WorkbenchStripIo,
} from "./zones/workbench-tool-strip";
import {
  CAD_FEATURE_FORM_LABELS,
  CURVE_FORM_LABELS,
  CurveFeatureForm,
  DATUM_FORM_LABELS,
  DatumFeatureForm,
  DraftFeatureForm,
  HelixFeatureForm,
  HoleFeatureForm,
  MirrorFeatureForm,
  PatternFeatureForm,
  PatternPathFeatureForm,
  RibFeatureForm,
  ScaleFeatureForm,
  SplitFeatureForm,
  BooleanFeatureForm,
  MoveBodyFeatureForm,
  PrimitiveFeatureForm,
  primitiveFormTitle,
  topologyCutFormTitle,
  faceOpFormTitle,
  type CadTopologyPickSelection,
  type CadTopologyPickTargetOption,
  DuplicateFeatureForm,
  BodyRenameForm,
  type CadFeatureBodyOption,
  ThreadFeatureForm,
  ThickenFeatureForm,
  CreateSheetForm,
  KnitSurfaceForm,
  OffsetSurfaceForm,
  LoftFeatureForm,
  ThickenSurfaceForm,
  TrimSurfaceForm,
  SweepFeatureForm,
  type CadFeatureSketchOption,
  type HoleFormValues,
} from "./feature-forms";
import { duplicateSourceOptions } from "./duplicate";
import {
  isPrimitiveKind,
  PRIMITIVE_KINDS,
  type PrimitiveKind,
  type PrimitiveSubmission,
} from "./primitive";
import {
  isTopologyCutKind,
  nearestTopologyAnchor,
  nextTopologyPicks,
  TOPOLOGY_CUT_KINDS,
  topologyPickOptionsOf,
  topologyTargetAnchorsOf,
  type TopologyCutKind,
  type TopologyCutSubmission,
  type TopologyPicks,
  type TopologyPickVerb,
} from "./topology-pick";
import {
  CadTopologyPickOverlay,
  CadTopologyPickPanel,
} from "./topology-pick-panel";
import {
  FACE_OP_KINDS,
  isFaceOpKind,
  type FaceOpKind,
  type FaceOpSubmission,
} from "./face-op-pick";
import { CadCurveOverlay } from "./curve-overlay";
import { CadDatumOverlay } from "./datum-overlay";
import { CadHolePreviewGhost } from "./hole-ghost";
import {
  createViewportViewSession,
  sessionWithConvention,
  sessionWithDisplayMode,
  sessionWithLightRig,
  sessionWithRenderQuality,
  sessionWithUserCamera,
  type ViewportViewSession,
} from "./viewport-view";
import {
  captureViewportPng,
  downloadBlob,
  isometricSeriesCameras,
  SERIES_DOWNLOAD_SPACING_MS,
  turntableCameras,
  waitForRenderedFrame,
} from "./snapshot-export";
import { CadViewportViewTools } from "./viewport-view-tools";
import {
  FeatureTimelineChips,
  FeatureTimelineSummary,
} from "./feature-timeline-strip";
import { WorkbenchMeasurementSection } from "./measurement-section";
import { honestSceneFallback } from "./scene-fallback";
import { sceneOperandOfBody } from "./extrude";
import { SketchMode } from "./SketchMode";
import { useWorkbenchEngine, type WorkbenchEngine } from "./workbench-engine";

/** The viewport fills its workspace region at every width (the camera
 * rig re-applies the spec's aspect on resize; the scene stays dpr 1). */
const VIEWPORT_CLASS = "h-full w-full";

/** The imported-mesh preview the composition renders in the viewport. */
export interface CadImportPreview {
  /** The format the mesh arrived through — the honest provenance. */
  readonly source: string;
  /** Provenance detail as stable JSON (flavor, unit, solids). */
  readonly detailJson: string;
  /** The validated, renderable imported projection. */
  readonly projection: RenderProjection;
  /** The imported soup's 3dp volume text (the settle stamp value). */
  readonly volumeText: string;
  /** The imported soup's triangle count. */
  readonly triangles: number;
}

/** The IO surface the host wires: formats, held bytes, and outcomes. */
export interface CadWorkbenchIo {
  /** The exportable formats (display order). */
  readonly exportFormats: readonly CadExportFormatOption[];
  /** The held exports (byte counts, details, download affordances). */
  readonly exportEntries: readonly CadExportEntry[];
  /** The format currently exporting, or `null`. */
  readonly exportPendingFormatId: string | null;
  /** The export error text ("" when none). */
  readonly exportError: string;
  /** Runs one export. */
  readonly onExport: (formatId: string) => void;
  /** The importable formats (display order). */
  readonly importFormats: readonly CadImportFormatOption[];
  /** Hands selected files to the host's import adapters. */
  readonly onImportFiles: (files: readonly File[]) => void;
  /** The held exports offered for a round-trip import. */
  readonly importHeld: readonly CadImportHeldEntry[];
  /** Whether an import is running. */
  readonly importPending: boolean;
  /** The import error text ("" when none). */
  readonly importError: string;
  /** The latest import's structured outcome, or `null`. */
  readonly importOutcome: CadImportOutcome | null;
  /** The active imported-mesh preview, or `null`. */
  readonly preview: CadImportPreview | null;
  /** Clears the preview (the viewport returns to the document). */
  readonly onClearPreview: () => void;
}

/** What every slot replacement receives: the public state, nothing else. */
export interface CadWorkbenchSlotContext {
  /** The shared workbench engine (public hooks, loop, actions, readouts). */
  readonly engine: WorkbenchEngine;
  /** The host-wired IO surface. */
  readonly io: CadWorkbenchIo;
}

/** A slot: returning a node replaces that surface's default piece. */
export type CadWorkbenchSlot = (context: CadWorkbenchSlotContext) => ReactNode;

/** The replaceable surfaces of the complete workbench. */
export interface CadWorkbenchSlots {
  /**
   * The host's one page-level row ABOVE the command row — the project
   * persistence bar of the document route (the WorkbenchLayout `bar`
   * slot's contract, carried over): one honest row of document-level
   * chrome, wrapped by the composition in the same hairline band the
   * old layout used. Absent on the bare route, whose DOM stays
   * unchanged.
   */
  readonly bar?: CadWorkbenchSlot;
  /** The TOP zone's tool cluster (the strip's first group). */
  readonly toolbar?: CadWorkbenchSlot;
  /** The feature band's history timeline (full width, below the workspace). */
  readonly historyTimeline?: CadWorkbenchSlot;
  /** The command menu (trigger + palette; the palette is portal-mounted). */
  readonly commandMenu?: CadWorkbenchSlot;
  /** The workspace's dominant viewport (fixed 800x520 box). */
  readonly viewport?: CadWorkbenchSlot;
  /** The left dock's model tree. */
  readonly modelTree?: CadWorkbenchSlot;
  /** The right dock's property panel. */
  readonly propertyPanel?: CadWorkbenchSlot;
  /** The right dock's parameter panel. */
  readonly parameterPanel?: CadWorkbenchSlot;
  /** The Phase 57 configuration surface (switcher, table, create, CSV). */
  readonly configurationPanel?: CadWorkbenchSlot;
  /**
   * The status band's content. The BAND (`WorkbenchStatusBand`) owns the
   * zone's top rule, surface and the settle lamp, so a node supplied here
   * renders transparent and borderless inside it — a slot that draws its
   * own band chrome doubles the frame's bottom rule.
   */
  readonly statusBar?: CadWorkbenchSlot;
  /** The import/export dialogs (portal-mounted). */
  readonly ioDialogs?: CadWorkbenchSlot;
}

/**
 * The composition's default status strip: the settled scene's live
 * readouts (status, volume, tool, selection, commands, error) on the
 * machine's fixed surface ids. Exported so a host page supplying a
 * `statusBar` slot can KEEP this strip verbatim — one source of truth
 * for the ids the session writer targets — while laying its own content
 * beside it (the share bar rides the status row; the bare route grows no
 * layout row of its own and its pinned canvas geometry stays put).
 */
export function CompleteWorkbenchStatusBar({
  className,
}: {
  /** Merged onto the strip (a host row lays it out beside its own content). */
  readonly className?: string;
}): ReactElement {
  return (
    <CadStatusBar
      className={className}
      surfaceIds={{
        statusId: "workbench-complete-status",
        volumeId: "workbench-complete-volume",
        errorId: "workbench-complete-error",
      }}
    />
  );
}

/** Props of {@link CompleteCadWorkbench}. */
export interface CompleteCadWorkbenchProps {
  /**
   * The worker backend the engine's session boots. The default `"manifold"`
   * is the boot state every established baseline pins; `"occt"` serves the
   * sweep-capable composition (Phase 38 — sweep and loft are honest
   * declines on Manifold). Boot-time configuration: remount to change it.
   */
  readonly backend?: FixtureSessionBackendId;
  /** Surface replacements, per named slot (see the composition contract). */
  readonly slots?: CadWorkbenchSlots;
  /**
   * The host-wired IO surface — either the object itself or a builder
   * receiving the engine (the export path reads the SETTLED scene through
   * that public surface). WITHOUT it the File commands and the dialogs
   * are structurally absent — the workbench never pretends to exchange
   * files it has no adapters for.
   */
  readonly io?: CadWorkbenchIo | ((engine: WorkbenchEngine) => CadWorkbenchIo);
  /** The root element id (the machine surface's anchor). */
  readonly rootId?: string;
}

/**
 * The primitive verbs' search keywords: the kind's own name plus the
 * synonyms an author types for it (`cube`, `ball`, `rod`, …) and the
 * shared "primitive solid" vocabulary, so a blank-bench author finds the
 * sketch-free path from the command menu.
 */
const PRIMITIVE_COMMAND_KEYWORDS: Readonly<Record<PrimitiveKind, string>> = {
  box: "box cube cuboid block rectangular primitive solid create add",
  sphere: "sphere ball round primitive solid create add",
  cylinder: "cylinder rod tube round primitive solid create add",
  cone: "cone taper frustum point primitive solid create add",
};

/**
 * The topology-cut verbs' search keywords: the kind's name plus the
 * synonyms an author types for it (`round`, `bevel`, `hollow`, …).
 */
const TOPOLOGY_CUT_COMMAND_KEYWORDS: Readonly<Record<TopologyCutKind, string>> =
  {
    fillet: "fillet round radius blend edge edges pick solid modify",
    chamfer: "chamfer bevel edge edges distance pick solid modify",
    shell: "shell hollow open face faces wall thickness pick solid modify",
  };

/**
 * The face-op verbs' search keywords: the kind's name plus the synonyms
 * an author types for it (`push`, `pull`, `remove`, `flatten`, …).
 */
const FACE_OP_COMMAND_KEYWORDS: Readonly<Record<FaceOpKind, string>> = {
  moveFace: "move face push pull offset axis distance pick solid modify direct",
  deleteFace: "delete face remove heal pick solid modify direct",
  replaceFace: "replace face datum plane flatten trim pick solid modify direct",
};

/**
 * The face-op verbs' command-menu ids: kebab-case, the menu's multi-word
 * id convention (`move-body`, `pattern-path`, `sketch-on-face`).
 */
const FACE_OP_COMMAND_IDS: Readonly<Record<FaceOpKind, string>> = {
  moveFace: "move-face",
  deleteFace: "delete-face",
  replaceFace: "replace-face",
};

/**
 * The first-run sketch hint's persistence: dismissed once per browser
 * (entering sketch mode counts as dismissed — the discovery worked).
 */
const SKETCH_HINT_STORAGE_KEY = "slopcad.sketch-hint.dismissed";

/** Reads the hint's persisted dismissal, tolerating stripped storage. */
function sketchHintStoredDismissal(): boolean {
  try {
    return window.localStorage.getItem(SKETCH_HINT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The DRO's value ink: instrument ink, tabular, in BOTH registers.
 *
 * These digits used to be emissive amber with a glow. They are data, not a
 * signal — and the accent rule (DESIGN.md) reserves the signal colour for
 * the armed tool, the selected entity and one confirming action. With a
 * body selected the old treatment put amber on the extents, the volume,
 * the triangle count AND the tool name at once, which is how a cockpit
 * stops being readable: when everything glows, nothing reads.
 */
const DRO_VALUE = "text-ink tabular";

/**
 * The complete CAD workbench: all eight plan surfaces composed over the
 * shared engine, every piece replaceable by slot, every interaction routed
 * through the public CAD APIs.
 */
export function CompleteCadWorkbench({
  backend,
  io,
  rootId = "workbench-complete-root",
  slots = {},
}: CompleteCadWorkbenchProps): ReactElement {
  const engine = useWorkbenchEngine({
    backend,
    rootId,
    statusId: "workbench-complete-status",
    volumeId: "workbench-complete-volume",
    errorId: "workbench-complete-error",
    // The fluid viewport: its canvas size follows the window, so the anchor
    // projection must read the LIVE frame (see the engine's viewportId).
    viewportId: "workbench-complete-viewport",
  });
  const {
    applied,
    historyApi,
    holeBase,
    mode,
    noteRenderedFrame,
    regenerationIssue,
    regenerationStates,
    rollback,
    selectionApi,
    setMode,
    setRollback,
    storedHole,
    timeline,
    timelineJson,
    toolsApi,
    toggleSuppressed,
    handleExtrude,
    handleHole,
    handleRevolve,
    handleSaveSketch,
    handleSweep,
    handleLoft,
    handleCreateSheet,
    handleTrimSurface,
    handleThickenSurface,
    handleKnitSurface,
    handleOffsetSurface,
    handleHelix,
    handleThread,
    handleDraft,
    handleRib,
    handleScale,
    handleThicken,
    handleSplit,
    handleBoolean,
    handleMoveBody,
    handlePrimitive,
    handleTopologyCut,
    handleFaceOp,
    handleDuplicate,
    handleBodyAppearance,
    handleBodyRename,
    handleBodyVisibility,
    handleBodyIsolate,
    handleStructuredHole,
    handlePattern,
    handlePatternPath,
    handleMirror,
    handleSketchOnFace,
    sketchBootWorkplane,
    datumsJson,
    handleCreateDatum,
    curvesJson,
    handleCreateCurve,
  } = engine;

  // Dialog + palette state: composition-owned UI state (replaced entirely
  // by the matching slot, which receives the io adapter and may own its own).
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  // The configuration panel's CSV read failure (the engine never sees the
  // file — the read dies in the panel's file input, before any CSV text
  // exists). It rides the SAME notice region as the engine's configuration
  // refusals and clears on the panel's next user action, mirroring the
  // engine notice's own lifecycle.
  const [csvImportReadError, setCsvImportReadError] = useState<string | null>(
    null,
  );
  // The Phase 38 feature dialog: the sweep/loft create forms. One dialog,
  // kind-switched; the last submission's structured refusal rides here (the
  // parameter panel's apply-failure precedent) and clears on the next open.
  const [featureDialog, setFeatureDialog] = useState<
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
    | "datum"
    | "curve"
    | "boolean"
    | "moveBody"
    | "duplicate"
    | PrimitiveKind
    | TopologyCutKind
    | FaceOpKind
    | null
  >(null);
  // The pick dialogs' surface (fillet/chamfer/shell and the face ops): the
  // computed bodies whose VISIBLE solid the kernel can name (persistent
  // topology), each with its on-demand snapshot — `null` while the query
  // is in flight.
  const [topologyPickTargets, setTopologyPickTargets] = useState<
    readonly CadTopologyPickTargetOption[] | null
  >(null);
  // The failure text of a topology query that rejected (the worker died,
  // or the kernel threw) — a terminal state, so the dialog never hangs on
  // loading; `null` while no query has failed.
  const [topologyPickQueryError, setTopologyPickQueryError] = useState<
    string | null
  >(null);
  // The viewport picks of the open topology verb: ONE target body and the
  // snapshot ordinals clicked on it (the chain's anchor gesture) — reset
  // whenever the offered snapshots are re-read, so a pick always
  // addresses the snapshot it was clicked on.
  const [topologyPicks, setTopologyPicks] = useState<TopologyPicks | null>(
    null,
  );
  // The Phase 44 body rename dialog: which body's rename form is open.
  const [renameBodyId, setRenameBodyId] = useState<string | null>(null);
  const [featureOutcome, setFeatureOutcome] = useState<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string; readonly message: string }
    | null
  >(null);
  // The hole dialog's LIVE values (the preview ghost's input): written by
  // the form's own change hook, cleared when the dialog closes.
  const [holeDialogValues, setHoleDialogValues] =
    useState<HoleFormValues | null>(null);
  const [importedFrames, setImportedFrames] = useState(0);
  // The settle lamp's honest state: the document whose pixels the last
  // settled frame actually rendered. A commit flips the lamp to "waiting"
  // the instant the document identity changes (the pixels now lag the
  // document) and back to "settled" when the regenerated scene's first
  // settled frame stamps. An import preview never settles the document.
  const [settledDocument, setSettledDocument] = useState<unknown>(null);
  // The two rails' own state (LEFT and RIGHT): collapsed-to-icon-width
  // per rail plus the disclosure of every rail section, persisted per
  // browser. This replaces the width-conditional drawer the docks used
  // to be — see ./rail-state for why width may pick a DEFAULT and never
  // the existence of a control.
  const rails = useWorkbenchRailState();
  // The dialog trigger buttons: the dialogs open from state (these buttons,
  // the palette's File commands), so the primitive cannot track the opener
  // itself — these refs are the documented focus-restoration points.
  const importTriggerRef = useRef<HTMLButtonElement | null>(null);
  const exportTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The first-run sketch hint: visible until dismissed or until the user
  // actually enters sketch mode (either is the discovery win). Dismissal
  // persists per browser; the initial render shows the hint on server and
  // client alike (hydration-safe) and the stored dismissal applies in an
  // effect, so the markup never depends on storage at hydration time.
  const [sketchHintDismissed, setSketchHintDismissed] = useState(false);
  // The last import outcome the auto-close has seen (identity-tracked: the
  // builder-built io surface re-mints the outcome object every render).
  const seenOutcomeRef = useRef<CadImportOutcome | null>(null);
  // The Phase 45 viewport view session: the user-camera overlay, display
  // mode, and angle convention — session state only, never serialized
  // (ADR: docs/architecture/adr-user-camera-overlay.md). Every writer is
  // a user action: the strip's commands and the gesture commits that
  // arrive through the viewport's onUserCamera.
  const [viewSession, setViewSession] = useState<ViewportViewSession>(
    createViewportViewSession,
  );
  const handleViewUserCamera = useCallback(
    (camera: ViewportViewSession["userCamera"]) => {
      setViewSession((session) => sessionWithUserCamera(session, camera));
    },
    [],
  );
  const handleViewDisplayMode = useCallback(
    (displayMode: ViewportViewSession["displayMode"]) => {
      setViewSession((session) => sessionWithDisplayMode(session, displayMode));
    },
    [],
  );
  const handleViewConvention = useCallback(
    (convention: ViewportViewSession["convention"]) => {
      setViewSession((session) => sessionWithConvention(session, convention));
    },
    [],
  );
  const handleViewLightRig = useCallback((rigId: string) => {
    setViewSession((session) => sessionWithLightRig(session, rigId));
  }, []);
  const handleViewRenderQuality = useCallback(
    (quality: ViewportViewSession["renderQuality"]) => {
      setViewSession((session) => sessionWithRenderQuality(session, quality));
    },
    [],
  );
  const ioSurface: CadWorkbenchIo = useMemo(
    () =>
      io === undefined
        ? {
            exportFormats: [],
            exportEntries: [],
            exportPendingFormatId: null,
            exportError: "",
            onExport: () => {},
            importFormats: [],
            onImportFiles: () => {},
            importHeld: [],
            importPending: false,
            importError: "",
            importOutcome: null,
            preview: null,
            onClearPreview: () => {},
          }
        : typeof io === "function"
          ? io(engine)
          : io,
    [io, engine],
  );

  const context: CadWorkbenchSlotContext = useMemo(
    () => ({ engine, io: ioSurface }),
    [engine, ioSurface],
  );

  const showingPreview = ioSurface.preview !== null;
  // The Phase 59 appearance resolution: the document's body records ride
  // their display data onto the applied projection at the host seam —
  // pure data, identity fast path when no record exists (the boot state's
  // bytes and memoization stay untouched).
  const appearedProjection = useMemo(
    () =>
      applied === null
        ? null
        : withBodyAppearances(
            applied.state.projection,
            engine.documentApi.document.bodies,
          ),
    [applied, engine],
  );
  const documentVolumeText =
    applied === null ? null : applied.state.measurement.volume.toFixed(3);
  // The Phase 59 snapshot exports: the PNG snapshot captures the settled
  // canvas directly; the series drive each camera through the session
  // overlay (a user command's writes, restored afterwards), capture one
  // frame-verified shot per step, and restore the previous overlay.
  const viewportCanvas = useCallback(
    (): HTMLCanvasElement | null =>
      document.querySelector<HTMLCanvasElement>(
        "#workbench-complete-viewport canvas",
      ),
    [],
  );
  const exportSnapshotPng = useCallback(async (): Promise<void> => {
    const canvas = viewportCanvas();
    if (canvas === null) return;
    const blob = await captureViewportPng(canvas);
    if (blob !== null) downloadBlob(blob, "slopcad-snapshot.png");
  }, [viewportCanvas]);
  const exportCameraSeries = useCallback(
    async (cameras: readonly RenderCamera[], prefix: string): Promise<void> => {
      const framesAtStart = engine.renderedFrames;
      const previous = viewSession.userCamera;
      const shots: { readonly blob: Blob; readonly name: string }[] = [];
      for (const [index, camera] of cameras.entries()) {
        handleViewUserCamera(camera);
        await waitForRenderedFrame(rootId, framesAtStart + index + 1);
        const canvas = viewportCanvas();
        if (canvas === null) continue;
        const blob = await captureViewportPng(canvas);
        if (blob !== null) {
          shots.push({ blob, name: `${prefix}-${String(index)}.png` });
        }
      }
      handleViewUserCamera(previous);
      for (const shot of shots) {
        downloadBlob(shot.blob, shot.name);
        // Paced, not batched: a browser starts programmatic anchor
        // downloads asynchronously, and a synchronous loop of clicks can
        // collapse them onto the first download's entry (name and bytes).
        // A short gap lets each file start under its own name.
        await new Promise((resolve) => {
          setTimeout(resolve, SERIES_DOWNLOAD_SPACING_MS);
        });
      }
    },
    [
      engine,
      handleViewUserCamera,
      rootId,
      viewportCanvas,
      viewSession.userCamera,
    ],
  );
  const exportTurntableSeries = useCallback(
    async (base: RenderCamera): Promise<void> => {
      await exportCameraSeries(
        turntableCameras(base, 8, 45),
        "slopcad-turntable",
      );
    },
    [exportCameraSeries],
  );
  const exportIsometricSeries = useCallback(async (): Promise<void> => {
    const bounds =
      applied === null || showingPreview
        ? null
        : applied.state.measurement.bounds;
    if (bounds === null) return;
    await exportCameraSeries(
      isometricSeriesCameras(bounds, viewSession.convention),
      "slopcad-iso",
    );
  }, [applied, exportCameraSeries, showingPreview, viewSession.convention]);
  // Settled = the last settled frame rendered THIS document (and no
  // import preview is on the stage — a preview's pixels are never the
  // document's).
  const settled =
    !showingPreview &&
    settledDocument !== null &&
    settledDocument === engine.documentApi.document;

  // A successful import closes the dialog: the result IS the preview, now
  // visible in the viewport under its truth-telling chip. A failed import
  // keeps the dialog open with its structured error.
  useEffect(() => {
    const outcome = ioSurface.importOutcome;
    if (outcome !== null && seenOutcomeRef.current !== outcome) {
      setImportDialogOpen(false);
    }
    seenOutcomeRef.current = outcome;
  }, [ioSurface.importOutcome]);

  const clearSelection = useCallback(() => {
    selectionApi.clear();
  }, [selectionApi]);

  const dismissSketchHint = useCallback(() => {
    setSketchHintDismissed(true);
    try {
      window.localStorage.setItem(SKETCH_HINT_STORAGE_KEY, "1");
    } catch {
      // A stripped context cannot persist; dismissal still holds for the
      // session (the state above), which is the honest best effort.
    }
  }, []);

  // The stored dismissal (and the mode switch's own) apply after
  // hydration: the first-run hint never depends on storage at render time.
  useEffect(() => {
    if (sketchHintStoredDismissal()) {
      setSketchHintDismissed(true);
    }
  }, []);

  useEffect(() => {
    if (mode === "sketch") {
      dismissSketchHint();
    }
  }, [dismissSketchHint, mode]);

  // The honest scene fallback: an authoring action that REMOVES document
  // data (a feature deletion through the property panel, an undo) can
  // invalidate the active scene's request — the scene readers then return
  // null, and leaving the old pixels up would be fabrication. When the
  // active scene no longer resolves, the dispatch falls back to the
  // deepest scene the document still resolves (the create actions'
  // precedence: hole over loft over sweep over revolve over extrude, then
  // the plate). The effect only ever FALLS BACK — a newly created deeper
  // scene wins through its action's own setActiveScene, never through
  // this effect.
  const activeScene = engine.activeScene;
  const workbenchDocument = engine.documentApi.document;

  // The sketch pool the sweep/loft forms pick from: every document sketch
  // record, name verbatim. The create verbs stay disabled until the pool
  // holds at least two sketches (sweep needs profile + path; a loft needs
  // two sections minimum).
  const sketchOptions: readonly CadFeatureSketchOption[] =
    workbenchDocument.sketches.map((sketch) => ({
      id: sketch.id,
      name: sketch.name,
    }));
  const canAuthorSketchFeatures = sketchOptions.length >= 2;
  // A thread needs a target solid: the document's last extrude (the hole
  // verb's enablement precedent).
  const hasExtrudeBase = workbenchDocument.features.some(
    (entry) => entry.kind === "extrude",
  );
  // The datum-axis pool the helix form picks from: axis-kind records only.
  const datumAxisOptions = workbenchDocument.datums.flatMap((datum) => {
    const payload = parseDatumPayload(datum.datum);
    return payload.ok && payload.value.datumType === "axis"
      ? [{ id: datum.id, name: datum.name }]
      : [];
  });
  // The datum-PLANE pool the split form picks from: plane-kind records only.
  const datumPlaneOptions = workbenchDocument.datums.flatMap((datum) => {
    const payload = parseDatumPayload(datum.datum);
    return payload.ok && payload.value.datumType === "plane"
      ? [{ id: datum.id, name: datum.name }]
      : [];
  });
  // The LEFT rail's Datums section: every datum record, named verbatim,
  // with its parsed kind beside it. Unlike the pools above this one is
  // not filtered to a type — the rail lists the document's datum
  // geometry, and an unreadable payload says so rather than vanishing.
  const railDatums: readonly WorkbenchModelRailDatum[] =
    workbenchDocument.datums.map((datum) => {
      const payload = parseDatumPayload(datum.datum);
      return {
        id: datum.id,
        kind: payload.ok ? payload.value.datumType : null,
        name: datum.name,
      };
    });
  // The sheet-body pool the surface forms pick from (Phase 49): the
  // document's SHEET bodies, name verbatim.
  const sheetOptions: readonly {
    readonly id: string;
    readonly name: string;
  }[] = workbenchDocument.bodies
    .filter((body) => body.kind === "sheet")
    .map((body) => ({ id: body.id, name: body.name }));
  // The live parameter names the feature dialogs' `$`-token autocomplete
  // offers (Phase 21): every document parameter, name verbatim — a
  // submitted `$name` resolves against THIS list, so the suggestions can
  // never promise a reference the document cannot resolve.
  const parameterNameOptions: readonly string[] =
    workbenchDocument.parameters.parameters.map((parameter) => parameter.name);
  // The body pool the boolean form picks from (Phase 44): the bodies whose
  // producer carries a computable scene (`sceneOperandOfBody` — a plain
  // extrusion's output, or a composition's: pad, hole, boolean, moved
  // body, whose computed solid the document pass hands the boolean scene).
  // Any other producer — the seeded document's translate and rotate
  // bodies, sheets — declines the operand and the scene would silently
  // keep the prior render, so it stays out of the pool, name verbatim —
  // the sketch pool's discipline.
  const featureProducedBodies: readonly CadFeatureBodyOption[] =
    workbenchDocument.bodies.flatMap((body) =>
      sceneOperandOfBody(workbenchDocument, body.id) !== null
        ? [{ id: body.id, name: body.name }]
        : [],
    );
  // The duplicate dialog's source pool (Phase 60): the SAME computable-body
  // predicate, read through the duplicate module's own reader — a copy of
  // a copy is legal input, the verb's iterative use.
  const duplicateBodies = duplicateSourceOptions(workbenchDocument);
  // The topology pick surface: while a fillet/chamfer/shell or a face-op
  // dialog is open, query the SETTLED scene's topology on demand (never
  // per render) and offer every computed body whose snapshot the kernel
  // can name for the verb's entity kind. The query is tied to the applied
  // scene: before the first settle the dialog stays loading, and every
  // settle (the boot, or the pass a document edit dispatches) re-reads
  // it, so the picks always come from the scene that settled last. A
  // closed dialog or a superseded query never writes.
  const { documentTopology } = engine;
  const topologyPickDialog: TopologyPickVerb | null =
    featureDialog !== null &&
    (isTopologyCutKind(featureDialog) || isFaceOpKind(featureDialog))
      ? featureDialog
      : null;
  useEffect(() => {
    if (topologyPickDialog === null) return;
    setTopologyPickTargets(null);
    setTopologyPickQueryError(null);
    setTopologyPicks(null);
    // Only a scene settled on THIS document may be queried: while an edit's
    // pass is in flight the visible scene is still the previous document's,
    // and its snapshots would pair with the edited bodies. Picking stays
    // disabled (no targets) until the matching scene is visible.
    if (applied === null || !settled) return;
    const queriedRevision = applied.revision;
    let current = true;
    void documentTopology().then(
      (inventory) => {
        if (!current) return;
        if (inventory !== null && inventory.revision !== queriedRevision) {
          return;
        }
        setTopologyPickTargets(
          workbenchDocument.bodies.flatMap((body) => {
            const snapshot = inventory?.snapshots.get(body.id);
            return snapshot !== undefined &&
              sceneOperandOfBody(workbenchDocument, body.id) !== null &&
              topologyPickOptionsOf(snapshot, topologyPickDialog).length > 0
              ? [{ bodyId: body.id, name: body.name, snapshot }]
              : [];
          }),
        );
      },
      (error: unknown) => {
        if (!current) return;
        setTopologyPickQueryError(
          error instanceof Error ? error.message : String(error),
        );
      },
    );
    return () => {
      current = false;
    };
  }, [
    applied,
    documentTopology,
    settled,
    topologyPickDialog,
    workbenchDocument,
  ]);
  // The camera the anchors project through: the one the canvas renders
  // (the session's user camera over the settled scene's own).
  const topologyPickCamera =
    applied === null
      ? null
      : (viewSession.userCamera ?? applied.state.projection.camera);
  // The picks resolved against the offered targets: the picked target
  // (its snapshot is the one the ordinals address) and its ordinals.
  const topologyPickSelection: CadTopologyPickSelection | null = useMemo(() => {
    if (topologyPicks === null || topologyPickTargets === null) return null;
    const target = topologyPickTargets.find(
      (option) => option.bodyId === topologyPicks.bodyId,
    );
    return target === undefined
      ? null
      : { target, ordinals: topologyPicks.ordinals };
  }, [topologyPicks, topologyPickTargets]);
  // The viewport pick gesture (the chain's `pickEdgeAt`): a pointer-down
  // ON THE CANVAS selects the nearest projected anchor within the shared
  // radius and folds it into the picks; a miss changes nothing, and a
  // press on the floating panel or the view tools never picks.
  const handleTopologyPickPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>): void => {
      if (
        topologyPickDialog === null ||
        topologyPickTargets === null ||
        topologyPickCamera === null ||
        !(event.target instanceof HTMLCanvasElement)
      ) {
        return;
      }
      const frame = event.currentTarget.getBoundingClientRect();
      const hit = nearestTopologyAnchor(
        topologyTargetAnchorsOf(topologyPickTargets, topologyPickDialog, {
          camera: topologyPickCamera,
          width: frame.width,
          height: frame.height,
        }),
        event.clientX - frame.left,
        event.clientY - frame.top,
      );
      if (hit === null) return;
      setTopologyPicks((current) =>
        nextTopologyPicks(current, hit, topologyPickDialog),
      );
    },
    [topologyPickCamera, topologyPickDialog, topologyPickTargets],
  );
  // The body the rename dialog is renaming (its current name seeds the form).
  const renameBody =
    renameBodyId === null
      ? null
      : (workbenchDocument.bodies.find((body) => body.id === renameBodyId) ??
        null);

  /** Runs the sweep submission, surfacing the refusal and closing on success. */
  const submitSweep = (profileId: string, pathId: string): void => {
    const outcome = handleSweep(profileId, pathId);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the loft submission, surfacing the refusal and closing on success. */
  const submitLoft = (sections: readonly LoftSectionChoice[]): void => {
    const outcome = handleLoft(sections);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the create-sheet submission, surfacing the refusal and closing on success. */
  const submitCreateSheet = (
    submission: Parameters<typeof handleCreateSheet>[0],
  ): void => {
    const outcome = handleCreateSheet(submission);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the trim-surface submission, surfacing the refusal and closing on success. */
  const submitTrimSurface = (submission: {
    readonly sheetId: string;
    readonly toolId: string;
    readonly keepInside: 0 | 1;
  }): void => {
    const outcome = handleTrimSurface({
      ...submission,
      sheetId: createBodyId(submission.sheetId),
      toolId: createBodyId(submission.toolId),
    });
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the thicken-surface submission, surfacing the refusal and closing on success. */
  const submitThickenSurface = (submission: {
    readonly sheetId: string;
    readonly thicknessMm: number | string;
    readonly side: 1 | -1;
  }): void => {
    const outcome = handleThickenSurface({
      ...submission,
      sheetId: createBodyId(submission.sheetId),
    });
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the knit-surface submission, surfacing the refusal and closing on success. */
  const submitKnitSurface = (submission: {
    readonly sheetIds: readonly string[];
    readonly toleranceMm: number | string;
  }): void => {
    const outcome = handleKnitSurface({
      ...submission,
      sheetIds: submission.sheetIds.map((sheetId) => createBodyId(sheetId)),
    });
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the offset-surface submission, surfacing the refusal and closing on success. */
  const submitOffsetSurface = (submission: {
    readonly sheetId: string;
    readonly distanceMm: number | string;
  }): void => {
    const outcome = handleOffsetSurface({
      ...submission,
      sheetId: createBodyId(submission.sheetId),
    });
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the helix submission, surfacing the refusal and closing on success. */
  const submitHelix = (...args: Parameters<typeof handleHelix>): void => {
    const outcome = handleHelix(...args);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the thread submission, surfacing the refusal and closing on success. */
  const submitThread = (
    specification: Parameters<typeof handleThread>[0],
  ): void => {
    const outcome = handleThread(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the draft submission, surfacing the refusal and closing on success. */
  const submitDraft = (
    specification: Parameters<typeof handleDraft>[0],
  ): void => {
    const outcome = handleDraft(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the rib submission, surfacing the refusal and closing on success. */
  const submitRib = (specification: Parameters<typeof handleRib>[0]): void => {
    const outcome = handleRib(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the scale submission, surfacing the refusal and closing on success. */
  const submitScale = (
    specification: Parameters<typeof handleScale>[0],
  ): void => {
    const outcome = handleScale(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the thicken submission, surfacing the refusal and closing on success. */
  const submitThicken = (
    specification: Parameters<typeof handleThicken>[0],
  ): void => {
    const outcome = handleThicken(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the split submission, surfacing the refusal and closing on success. */
  const submitSplit = (specification: {
    readonly datumPlaneId: string;
    readonly side: 1 | -1;
  }): void => {
    const outcome = handleSplit(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the boolean submission (Phase 44), surfacing the refusal. */
  const submitBoolean = (specification: {
    readonly operation: "union" | "subtract" | "intersect";
    readonly targetBodyId: string;
    readonly toolBodyIds: readonly string[];
    readonly keepToolBodies: boolean;
  }): void => {
    const outcome = handleBoolean(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the move-body submission (Phase 44), surfacing the refusal. */
  const submitMoveBody = (specification: {
    readonly offsetMm: readonly [number, number, number];
    readonly rotation: {
      readonly axis: 1 | 2 | 3;
      readonly angleDeg: number;
    } | null;
  }): void => {
    const outcome = handleMoveBody(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs a primitive submission (box/sphere/cylinder/cone), surfacing the refusal. */
  const submitPrimitive = (submission: PrimitiveSubmission): void => {
    const outcome = handlePrimitive(submission);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs a moveFace / deleteFace / replaceFace submission, surfacing the refusal. */
  const submitFaceOp = (submission: FaceOpSubmission): void => {
    const outcome = handleFaceOp(submission);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs a fillet / chamfer / shell submission, surfacing the refusal. */
  const submitTopologyCut = (submission: TopologyCutSubmission): void => {
    const outcome = handleTopologyCut(submission);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the duplicate submission (Phase 60), surfacing the refusal. */
  const submitDuplicate = (
    specification: Parameters<typeof handleDuplicate>[0],
  ): void => {
    const outcome = handleDuplicate(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the structured hole submission, surfacing the refusal. */
  const submitStructuredHole = (
    submission: Parameters<typeof handleStructuredHole>[0],
  ): void => {
    const outcome = handleStructuredHole(submission);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the pattern submission, surfacing the refusal and closing on success. */
  const submitPattern = (specification: {
    readonly legs: readonly {
      readonly directionDeg: number;
      readonly count: number;
      readonly spacingMm: number;
    }[];
    readonly skips: readonly number[];
  }): void => {
    const outcome = handlePattern(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the path-pattern submission, surfacing the refusal and closing. */
  const submitPatternPath = (specification: {
    readonly sketchId: string;
    readonly count: number;
    readonly spacingMm: number;
    readonly orientation: number;
  }): void => {
    const outcome = handlePatternPath(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /** Runs the mirror submission, surfacing the refusal and closing on success. */
  const submitMirror = (specification: {
    readonly datumPlaneId: string;
    readonly merge: number;
  }): void => {
    const outcome = handleMirror(specification);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /**
   * Runs the curve submission (Phase 47), surfacing the refusal and
   * closing on success — the datum creation seam verbatim.
   */
  const submitCurve = (authoring: CurveAuthoring): void => {
    const outcome = handleCreateCurve(authoring);
    setFeatureOutcome(outcome);
    if (outcome.ok) setFeatureDialog(null);
  };

  /**
   * Opens one feature dialog with its outcome region reset. The hole dialog
   * additionally resets the preview ghost's live values (a fresh form mount
   * re-seeds them through its change hook).
   */
  const openFeatureDialog = useCallback(
    (
      kind:
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
        | "datum"
        | "curve"
        | "boolean"
        | "moveBody"
        | "duplicate"
        | PrimitiveKind
        | TopologyCutKind
        | FaceOpKind,
    ): void => {
      setFeatureOutcome(null);
      if (kind === "hole") {
        setHoleDialogValues(null);
      }
      setFeatureDialog(kind);
    },
    [],
  );
  // The sketch-on-face refusal (a curved face, an unsettled scene): the
  // last attempt's message, surfaced as the viewport's honest status chip.
  const [sketchOnFaceNote, setSketchOnFaceNote] = useState<string | null>(null);

  /** Runs the sketch-on-face pick for the currently selected face. */
  const sketchOnSelectedFace = useCallback(() => {
    const faceRef = selectionApi.selected.find(
      (reference) => reference.kind === "face",
    );
    if (faceRef === undefined || faceRef.kind !== "face") return;
    const outcome = handleSketchOnFace(faceRef);
    setSketchOnFaceNote(outcome.ok ? null : outcome.message);
  }, [handleSketchOnFace, selectionApi.selected]);

  // The selection holds exactly one synthetic face reference when a face
  // pick is live — the sketch-on-face verb's enablement.
  const hasFaceSelection =
    selectionApi.selected.length === 1 &&
    selectionApi.selected[0]?.kind === "face";

  useEffect(() => {
    // The shared, sweep/loft-aware fallback decision (./scene-fallback):
    // `null` while the active scene still resolves.
    const fallback = honestSceneFallback(workbenchDocument, activeScene);
    if (fallback === null) return;
    engine.setActiveScene(fallback);
  }, [activeScene, engine, workbenchDocument]);

  // The agent chat view state (PLAN-AGENT-CHAT Phase 4.4, D16): the right
  // sidebar's chat ↔ panels switch, persisted per browser — ONE source
  // shared by the Phase 4.5 sidebar mount and the palette commands below.
  const { setView: setAgentChatView, view: agentChatView } = useAgentChatView();
  // The live agent session slot: the chat panel reports its surface once
  // the Phase 4.5 mount renders it; until then the session-scoped agent
  // commands stay honestly disabled instead of dispatching into nothing.
  const agentChatSessionSlot = useMemo(() => createAgentChatSessionSlot(), []);
  const agentChatSession = useAgentChatSession(agentChatSessionSlot);

  // The command list is derived once per relevant state identity; every
  // run() routes through a public surface (the hooks and page actions).
  const commands = useMemo<readonly CadCommandDescriptor[]>(() => {
    const list: CadCommandDescriptor[] = [];
    const toolLabels: Readonly<Record<string, string>> = {
      [SELECT_TOOL_ID]: "Select",
      [MEASURE_TOOL_ID]: "Measure",
      [ROTATE_TOOL_ID]: "Rotate",
    };
    toolsApi.toolIds.forEach((toolId, index) => {
      list.push({
        disabled:
          toolsApi.phase === "active" && toolsApi.activeToolId === toolId,
        group: "Tools",
        id: `tool-${toolId}`,
        keywords: "activate tool arm",
        label: toolLabels[toolId] ?? toolId,
        run: () => {
          toolsApi.arm(toolId);
        },
        shortcut: index < 9 ? String(index + 1) : undefined,
      });
    });
    list.push(
      {
        disabled: !historyApi.canUndo,
        group: "History",
        id: "undo",
        label: "Undo",
        run: () => {
          historyApi.undo();
        },
      },
      {
        disabled: !historyApi.canRedo,
        group: "History",
        id: "redo",
        label: "Redo",
        run: () => {
          historyApi.redo();
        },
      },
      {
        disabled: rollback === null,
        group: "History",
        id: "clear-rollback",
        keywords: "timeline marker",
        label: "Remove rollback point",
        run: () => {
          setRollback(null);
        },
      },
    );
    list.push(
      {
        disabled: selectionApi.selected.length === 0,
        group: "Workspace",
        id: "clear-selection",
        keywords: "deselect",
        label: "Clear selection",
        run: clearSelection,
      },
      {
        group: "Workspace",
        id: "sketch",
        keywords: "draw extrude revolve create",
        label: "Sketch workspace",
        run: () => {
          setMode("sketch");
        },
      },
      {
        disabled: datumPlaneOptions.length === 0,
        group: "Workspace",
        id: "surface-create",
        keywords: "surface sheet plane patch datum create base untrimmed",
        label: "Create a base sheet on a datum plane",
        run: () => {
          openFeatureDialog("surface-create");
        },
      },
      {
        disabled: sheetOptions.length < 2,
        group: "Workspace",
        id: "surface-trim",
        keywords: "surface trim sheet tool region keep cut",
        label: "Trim one sheet by another",
        run: () => {
          openFeatureDialog("surface-trim");
        },
      },
      {
        disabled: sheetOptions.length === 0,
        group: "Workspace",
        id: "surface-thicken",
        keywords: "surface thicken sheet solid wall thickness",
        label: "Thicken a sheet into a solid",
        run: () => {
          openFeatureDialog("surface-thicken");
        },
      },
      {
        disabled: sheetOptions.length < 2,
        group: "Workspace",
        id: "surface-knit",
        keywords: "surface knit sew sheets shell tolerance stitch",
        label: "Knit sheets into a shell",
        run: () => {
          openFeatureDialog("surface-knit");
        },
      },
      {
        disabled: sheetOptions.length === 0,
        group: "Workspace",
        id: "surface-offset",
        keywords: "surface offset sheet move distance normals",
        label: "Offset a sheet",
        run: () => {
          openFeatureDialog("surface-offset");
        },
      },
      {
        disabled: holeBase === undefined,
        group: "Workspace",
        id: "hole",
        keywords: "cut drill solid create",
        label: "Hole the last extrusion",
        run: handleHole,
      },
      {
        disabled: !hasExtrudeBase,
        group: "Workspace",
        id: "hole-spec",
        keywords:
          "hole counterbore countersink taper threaded tap drill iso positions spec create",
        label:
          "Cut a structured hole (counterbore, countersink, taper, thread)",
        run: () => {
          openFeatureDialog("hole");
        },
      },
      // The primitive verbs: one row per kind, never disabled — a
      // primitive consumes nothing, so the verb works on a blank bench.
      ...PRIMITIVE_KINDS.map((kind) => ({
        group: "Workspace",
        id: `primitive-${kind}`,
        keywords: PRIMITIVE_COMMAND_KEYWORDS[kind],
        label: primitiveFormTitle(kind),
        run: () => {
          openFeatureDialog(kind);
        },
      })),
      // The topology-cut verbs: disabled until the document computes a
      // body to cut (the picks address a computed solid's topology).
      ...TOPOLOGY_CUT_KINDS.map((kind) => ({
        disabled: featureProducedBodies.length === 0,
        group: "Workspace",
        id: kind,
        keywords: TOPOLOGY_CUT_COMMAND_KEYWORDS[kind],
        label: topologyCutFormTitle(kind),
        run: () => {
          openFeatureDialog(kind);
        },
      })),
      // The face-op verbs: disabled until the document computes a body to
      // operate on (the face pick addresses a computed solid's topology);
      // replaceFace also needs a datum plane to re-close the face onto.
      ...FACE_OP_KINDS.map((kind) => ({
        disabled:
          featureProducedBodies.length === 0 ||
          (kind === "replaceFace" && datumPlaneOptions.length === 0),
        group: "Workspace",
        id: FACE_OP_COMMAND_IDS[kind],
        keywords: FACE_OP_COMMAND_KEYWORDS[kind],
        label: faceOpFormTitle(kind),
        run: () => {
          openFeatureDialog(kind);
        },
      })),
      {
        disabled: !canAuthorSketchFeatures,
        group: "Workspace",
        id: "sweep",
        keywords: "sweep pipe path spine solid create",
        label: "Sweep a profile along a path",
        run: () => {
          openFeatureDialog("sweep");
        },
      },
      {
        disabled: !canAuthorSketchFeatures,
        group: "Workspace",
        id: "loft",
        keywords: "loft sections morph solid create",
        label: "Loft ordered sections",
        run: () => {
          openFeatureDialog("loft");
        },
      },
      {
        disabled: !canAuthorSketchFeatures,
        group: "Workspace",
        id: "helix",
        keywords: "helix coil spring screw spiral curve create",
        label: "Sweep a profile along a helix",
        run: () => {
          openFeatureDialog("helix");
        },
      },
      {
        disabled: !canAuthorSketchFeatures,
        group: "Workspace",
        id: "draft",
        keywords: "draft taper extrude wall angle mold create",
        label: "Extrude with a draft taper",
        run: () => {
          openFeatureDialog("draft");
        },
      },
      {
        disabled: !(canAuthorSketchFeatures && hasExtrudeBase),
        group: "Workspace",
        id: "rib",
        keywords: "rib stiffener gusset union create",
        label: "Add a rib to the last extrusion",
        run: () => {
          openFeatureDialog("rib");
        },
      },
      {
        disabled: !hasExtrudeBase,
        group: "Workspace",
        id: "scale",
        keywords: "scale uniform factor transform create",
        label: "Scale the last extrusion",
        run: () => {
          openFeatureDialog("scale");
        },
      },
      {
        disabled: !hasExtrudeBase,
        group: "Workspace",
        id: "thicken",
        keywords: "thicken hollow shell wall offset create",
        label: "Hollow the last extrusion closed",
        run: () => {
          openFeatureDialog("thicken");
        },
      },
      {
        disabled: !(datumPlaneOptions.length >= 1 && hasExtrudeBase),
        group: "Workspace",
        id: "split",
        keywords: "split cut plane half body create",
        label: "Split the last extrusion by a plane",
        run: () => {
          openFeatureDialog("split");
        },
      },
      {
        disabled: !hasExtrudeBase,
        group: "Workspace",
        id: "pattern",
        keywords: "pattern array repeat instances legs skip linear create",
        label: "Pattern the last extrusion",
        run: () => {
          openFeatureDialog("pattern");
        },
      },
      {
        disabled: !(canAuthorSketchFeatures && hasExtrudeBase),
        group: "Workspace",
        id: "pattern-path",
        keywords:
          "pattern path chain arc length stations tangent follow create",
        label: "Repeat the last extrusion along a path",
        run: () => {
          openFeatureDialog("patternPath");
        },
      },
      {
        disabled: !(datumPlaneOptions.length >= 1 && hasExtrudeBase),
        group: "Workspace",
        id: "mirror",
        keywords: "mirror reflect datum plane symmetric merge copy create",
        label: "Mirror the last extrusion by a plane",
        run: () => {
          openFeatureDialog("mirror");
        },
      },
      {
        disabled: !hasExtrudeBase,
        group: "Workspace",
        id: "thread",
        keywords: "thread iso metric screw bolt tap helical create",
        label: "Thread the last extrusion",
        run: () => {
          openFeatureDialog("thread");
        },
      },
      {
        disabled: !hasFaceSelection,
        group: "Workspace",
        id: "sketch-on-face",
        keywords: "sketch on face datum plane anchor pad create",
        label: "Sketch on the selected face",
        run: sketchOnSelectedFace,
      },
      {
        disabled: !(featureProducedBodies.length >= 2),
        group: "Workspace",
        id: "boolean",
        keywords: "boolean union subtract intersect combine bodies cut join",
        label: "Combine bodies (boolean)",
        run: () => {
          openFeatureDialog("boolean");
        },
      },
      {
        disabled: !hasExtrudeBase,
        group: "Workspace",
        id: "move-body",
        keywords: "move translate rotate body position transform",
        label: "Move the last extrusion",
        run: () => {
          openFeatureDialog("moveBody");
        },
      },
      {
        disabled: duplicateBodies.length === 0,
        group: "Workspace",
        id: "duplicate",
        keywords:
          "duplicate copy transform translate rotate array repeat instances iterative create",
        label: "Duplicate & transform a body",
        run: () => {
          openFeatureDialog("duplicate");
        },
      },
      {
        group: "Workspace",
        id: "create-datum",
        keywords: "datum plane axis point coordinate system reference create",
        label: "Create datum geometry",
        run: () => {
          openFeatureDialog("datum");
        },
      },
      {
        group: "Workspace",
        id: "create-curve",
        keywords:
          "curve spline helix equation spine wire path interpolated control create",
        label: "Create a 3D curve",
        run: () => {
          openFeatureDialog("curve");
        },
      },
    );
    if (io !== undefined) {
      list.push(
        {
          disabled: applied === null,
          group: "File",
          id: "export",
          keywords: "stl 3mf glb save download",
          label: "Export model",
          run: () => {
            setExportDialogOpen(true);
          },
        },
        {
          group: "File",
          id: "import",
          keywords: "stl 3mf obj step brep iges dxf svg open upload",
          label: "Import model",
          run: () => {
            setImportDialogOpen(true);
          },
        },
      );
    }
    list.push(
      {
        disabled: applied === null,
        group: "File",
        id: "export-snapshot-png",
        keywords: "snapshot png image capture viewport screenshot export",
        label: "Export viewport snapshot (PNG)",
        run: () => {
          void exportSnapshotPng();
        },
      },
      {
        disabled: applied === null,
        group: "File",
        id: "export-turntable",
        keywords: "turntable series rotate frames png snapshot export",
        label: "Export turntable series (8 frames)",
        run: () => {
          const camera =
            viewSession.userCamera ??
            (showingPreview
              ? (ioSurface.preview?.projection.camera ?? null)
              : (applied?.state.projection.camera ?? null));
          if (camera !== null) void exportTurntableSeries(camera);
        },
      },
      {
        disabled: applied === null,
        group: "File",
        id: "export-isometric",
        keywords: "isometric series front top right views png snapshot export",
        label: "Export isometric series (4 views)",
        run: () => {
          void exportIsometricSeries();
        },
      },
    );
    // The four agent chat commands (Phase 4.4): the toggle rides the
    // shared view state; the session-scoped three dispatch through the
    // live session the mounted chat panel reports.
    list.push(
      ...createAgentChatCommands({
        session: agentChatSession,
        view: agentChatView,
        onViewChange: setAgentChatView,
      }),
    );
    return list;
  }, [
    agentChatSession,
    agentChatView,
    applied,
    canAuthorSketchFeatures,
    clearSelection,
    duplicateBodies.length,
    exportIsometricSeries,
    exportSnapshotPng,
    exportTurntableSeries,
    featureProducedBodies.length,
    handleHole,
    hasExtrudeBase,
    datumPlaneOptions.length,
    sheetOptions.length,
    hasFaceSelection,
    historyApi,
    holeBase,
    io,
    ioSurface.preview?.projection.camera,
    openFeatureDialog,
    rollback,
    selectionApi.selected.length,
    setAgentChatView,
    setMode,
    setRollback,
    showingPreview,
    sketchOnSelectedFace,
    toolsApi,
    viewSession.userCamera,
  ]);

  // The WebMCP binding (Phase 7 + the Phase 2.1 capture tool + the site's
  // authoring skill): the twelve workbench tools registered for the page's
  // lifetime — always in the
  // internal registry, mirrored to `document.modelContext` when the browser
  // exposes the agent surface. The capture tool drives the page's own
  // camera-overlay writer, frame ledger, and live canvas — the same
  // machinery the snapshot-export commands run.
  const webMcpEntries = useWorkbenchWebMcpTools({
    capture: {
      canvas: viewportCanvas,
      convention: () => viewSession.convention,
      renderedFrames: () => engine.renderedFrames,
      rootId,
      setUserCamera: handleViewUserCamera,
      userCamera: () => viewSession.userCamera,
    },
    commands,
    engine,
  });
  // The agent chat's tools surface (Phase 4.5, M2): the page's own bound
  // tool set plus the registry executor — the same binding the WebMCP
  // mirror serves, never a second tool set.
  const agentToolsSurface = useMemo<AgentToolsSurface>(
    () => ({ execute: executeWebMcpTool, tools: webMcpEntries }),
    [webMcpEntries],
  );

  // -- Default pieces (each exactly what its slot replaces) -----------------

  // Left-drag-orbit yields only to an armed tool whose gesture vocabulary
  // owns model drags (rotate). The armed-at-rest click tools — select and
  // measure — coexist with orbiting: the drag threshold separates a camera
  // gesture from a pick.
  const cameraOrbitDragAvailable =
    toolsApi.phase !== "active" ||
    toolsApi.activeToolId === null ||
    toolsApi.activeToolId === SELECT_TOOL_ID ||
    toolsApi.activeToolId === MEASURE_TOOL_ID;

  const defaultToolbar = <CadToolbar className="border-0 bg-transparent p-0" />;

  /*
   * The getting-started card's ONE visibility truth.
   *
   * It used to be `!dismissed` alone, which meant the first-run card
   * floated over the bottom of the stage for the whole session — over a
   * finished body, over a selection, over the view strip — teaching a
   * first step the operator had already taken. A hint that outstays its
   * question is chrome, not help.
   *
   * It now retires the moment the document carries a feature: the card has
   * been answered. Dismissal (and entering sketch mode) still retire it
   * the same way, still persist per browser, and every trigger keeps its
   * testid — `data-sketch-hint` simply publishes this same truth, so the
   * attribute and the pixels can never disagree.
   */
  const sketchHintOpen =
    !showingPreview && !sketchHintDismissed && (timeline?.length ?? 0) === 0;

  const defaultHistoryTimeline = (
    <div
      aria-label="Feature timeline"
      className="flex h-9 min-w-0 shrink-0 items-center gap-(--gap-group) overflow-hidden border-t border-rule bg-chrome px-(--pad-panel)"
      data-testid="complete-feature-timeline"
      role="group"
    >
      <span className="label-section shrink-0 text-ink-faint">Timeline</span>
      {timeline === null ? (
        <span className="shrink-0 text-ui text-ink-dim">
          {regenerationIssue ?? "\u2026"}
        </span>
      ) : (
        <>
          {/* The document's history gets the FULL frame width: the feature
              band is its own row below the workspace (the silhouette CAD
              engineers already trust), so the chain stops competing with
              the command row for pixels. The chain scrolls HERE alone; the
              counter sits outside the scrolled content, so a long feature
              chain can never clip it mid-word (nor can the counter squeeze
              the chips). Scroll snap keeps every rest position whole-chip,
              the edges fade, and the container query collapses the chips
              entirely once the window can no longer host one. */}
          <div className="h-full min-w-0 flex-1 @container">
            <div className="no-scrollbar flex h-full w-full snap-x snap-mandatory items-center gap-1 overflow-x-auto @max-[150px]:hidden [mask-image:linear-gradient(to_right,transparent_0,black_10px,black_calc(100%_-_14px),transparent)]">
              <FeatureTimelineChips
                entries={timeline}
                rollback={rollback}
                onRollback={setRollback}
                onToggleSuppressed={toggleSuppressed}
              />
            </div>
          </div>
          <FeatureTimelineSummary entries={timeline} rollback={rollback} />
        </>
      )}
    </div>
  );

  const defaultCommandMenu = (
    <>
      {/* The palette's trigger is a strip control like any other: the mark
          carries it at every width, the accessible name is unchanged, and
          the binding is published as `aria-keyshortcuts` instead of as a
          key cap the row then had to hide below `xl`. */}
      <ToolButton
        aria-keyshortcuts="Control+K"
        aria-label="Open the command menu (Ctrl+K)"
        data-testid="complete-command-menu-trigger"
        onClick={() => {
          setCommandMenuOpen(true);
        }}
        size="icon"
        title="Open the command menu (Ctrl+K)"
      >
        <Command aria-hidden="true" />
      </ToolButton>
      <CadCommandMenu
        commands={commands}
        onOpenChange={setCommandMenuOpen}
        open={commandMenuOpen}
      />
    </>
  );

  // The document's first section record (Phase 46): the persisted plane the
  // clip and view toggles act on — absent when the document carries none.
  const engineSectionRecord = workbenchDocument.sections[0];

  const defaultViewport = (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-viewport-showing={showingPreview ? "import" : "document"}
      id="workbench-complete-viewport"
    >
      {/* The canvas owns every pixel the docks leave it: full-bleed, no
          bezel, no stage — the machine fills its frame. The settle and
          selection stamps are unchanged. */}
      <div
        className="relative min-h-0 flex-1"
        data-topology-picking={topologyPickDialog ?? undefined}
        onPointerDown={handleTopologyPickPointer}
      >
        <CadViewport
          cameraControls
          cameraOrbitDragEnabled={cameraOrbitDragAvailable}
          clippingPlanes={
            engine.sectionClipped && !engine.sectionViewMode
              ? clippingPlanesOf([
                  {
                    origin: engineSectionRecord?.origin ?? [0, 0, 0],
                    normal: engineSectionRecord?.normal ?? [0, 0, 1],
                    keepSide: engineSectionRecord?.keepSide ?? 1,
                  },
                ])
              : undefined
          }
          className={VIEWPORT_CLASS}
          displayMode={viewSession.displayMode}
          lightRig={lightRigById(viewSession.lightRig)}
          renderQuality={viewSession.renderQuality}
          onUserCamera={handleViewUserCamera}
          projection={
            showingPreview
              ? (ioSurface.preview?.projection ?? null)
              : applied === null
                ? null
                : appearedProjection
          }
          userCamera={viewSession.userCamera}
          onCameraSettled={() => {
            // The camera-commit frame: a committed overlay state (a series
            // step, a standard view, a restored spec) reached its first
            // rendered frame. Count it on the rendered-frames ledger —
            // COUNT ONLY: the settle-volume surface stays
            // document-settle-anchored (a camera application is not a
            // document action). Gesture commits are the only source (a
            // drag never re-renders per pointer move), so the ledger
            // advances exactly once per rendered camera state.
            noteRenderedFrame(null);
          }}
          onSettled={() => {
            if (showingPreview) {
              // The imported frame stamps the IMPORT surface, never the
              // document's — an imported mesh is not the parametric model.
              document
                .getElementById(rootId)
                ?.setAttribute(
                  "data-cad-imported-volume",
                  ioSurface.preview?.volumeText ?? "",
                );
              setImportedFrames((frames) => frames + 1);
              return;
            }
            // Settle protocol: pixels may be compared only once this stamp
            // agrees with the settled volume, written synchronously. The
            // settle lamp reads the same agreement: this frame rendered
            // THIS document.
            noteRenderedFrame(documentVolumeText);
            setSettledDocument(engine.documentApi.document);
          }}
          onSelectionRendered={(key) => {
            document
              .getElementById(rootId)
              ?.setAttribute("data-cad-selection-frame", key);
          }}
          overlay={
            <>
              {/* The registration brackets: the stage's corners are framed
                  like a drawing sheet around the workpiece — the same
                  "captured region" language as the DRO band below it. */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0"
              >
                <span className="absolute top-1.5 left-1.5 size-2.5 border-t border-l border-viewport-rule-strong" />
                <span className="absolute top-1.5 right-1.5 size-2.5 border-t border-r border-viewport-rule-strong" />
                <span className="absolute bottom-1.5 left-1.5 size-2.5 border-b border-l border-viewport-rule-strong" />
                <span className="absolute right-1.5 bottom-1.5 size-2.5 border-r border-b border-viewport-rule-strong" />
              </div>
              {showingPreview ? (
                <div className="pointer-events-auto absolute top-2 left-2 flex items-center gap-(--gap) rounded-sm border border-viewport-rule bg-viewport-scrim px-2 py-1">
                  <span className="font-mono text-data text-viewport-ink-dim">
                    {`preview: ${ioSurface.preview?.source ?? ""} mesh: geometry only, not in the document`}
                  </span>
                  <ToolButton
                    className="text-viewport-ink-dim hover:bg-viewport-rule hover:text-viewport-ink"
                    data-testid="complete-clear-import"
                    onClick={ioSurface.onClearPreview}
                    size="sm"
                  >
                    Back to model
                  </ToolButton>
                </div>
              ) : null}
              {!showingPreview &&
              applied !== null &&
              workbenchDocument.datums.length > 0 ? (
                <CadDatumOverlay
                  document={workbenchDocument}
                  projection={applied.state.projection}
                />
              ) : null}
              {/* The Phase 47 curve overlay: the document's 3D curve
                  records as camera-projected station polylines over the
                  settled scene — the datum overlay's discipline (a pure
                  function of document and projection, never serialized). */}
              {!showingPreview &&
              applied !== null &&
              workbenchDocument.curves.length > 0 ? (
                <CadCurveOverlay
                  document={workbenchDocument}
                  projection={applied.state.projection}
                />
              ) : null}
              {/* The Phase 42 hole dialog's preview ghost: the planned
                  hole's footprint over the settled scene, a pure function
                  of the dialog's live values — never a dispatch, never
                  serialized (the datum overlay's discipline). */}
              {!showingPreview &&
              applied !== null &&
              featureDialog === "hole" &&
              holeDialogValues !== null ? (
                <CadHolePreviewGhost
                  bounds={applied.state.measurement.bounds}
                  document={workbenchDocument}
                  projection={applied.state.projection}
                  values={holeDialogValues}
                />
              ) : null}
              {/* The topology verbs' NON-MODAL pick surface: the
                  projected anchors over the settled scene and the
                  floating panel carrying the picks and the verb's form —
                  the canvas stays live for orbit and pick. */}
              {!showingPreview &&
              topologyPickDialog !== null &&
              topologyPickTargets !== null &&
              topologyPickCamera !== null ? (
                <CadTopologyPickOverlay
                  camera={topologyPickCamera}
                  picks={topologyPicks}
                  targets={topologyPickTargets}
                  verb={topologyPickDialog}
                />
              ) : null}
              {!showingPreview && topologyPickDialog !== null ? (
                <CadTopologyPickPanel
                  datumPlanes={datumPlaneOptions}
                  error={
                    featureOutcome !== null && !featureOutcome.ok
                      ? `${featureOutcome.code}: ${featureOutcome.message}`
                      : null
                  }
                  key={topologyPickDialog}
                  onCancel={() => {
                    setFeatureDialog(null);
                    setFeatureOutcome(null);
                  }}
                  onFaceOp={submitFaceOp}
                  onTopologyCut={submitTopologyCut}
                  queryError={topologyPickQueryError}
                  selection={topologyPickSelection}
                  targets={topologyPickTargets}
                  verb={topologyPickDialog}
                />
              ) : null}
              {sketchOnFaceNote !== null ? (
                <div
                  className="absolute top-2 right-2 max-w-sm rounded-sm border border-destructive/40 bg-overlay px-2 py-1 text-ui text-destructive shadow-overlay"
                  data-testid="sketch-on-face-note"
                  role="alert"
                >
                  {sketchOnFaceNote}
                </div>
              ) : null}
              {/* The Phase 45 navigation/display strip: view cube,
                  standard views, projection toggle, display modes, fit,
                  zoom window, look-at, reset — every command writing the
                  session overlay (never the document). */}
              <CadViewportViewTools
                bounds={
                  showingPreview || applied === null
                    ? null
                    : applied.state.measurement.bounds
                }
                currentCamera={
                  viewSession.userCamera ??
                  (showingPreview
                    ? (ioSurface.preview?.projection.camera ?? null)
                    : applied === null
                      ? null
                      : applied.state.projection.camera)
                }
                onConvention={handleViewConvention}
                onDisplayMode={handleViewDisplayMode}
                onLightRig={handleViewLightRig}
                onRenderQuality={handleViewRenderQuality}
                onUserCamera={handleViewUserCamera}
                projection={
                  showingPreview
                    ? (ioSurface.preview?.projection ?? null)
                    : applied === null
                      ? null
                      : appearedProjection
                }
                selection={selectionApi.selected}
                session={viewSession}
              />
              {sketchHintOpen ? (
                <div
                  className="pointer-events-auto absolute bottom-3 left-1/2 w-max max-w-[calc(100%-1rem)] -translate-x-1/2"
                  data-testid="workbench-sketch-hint"
                >
                  {/* The card is a floating surface, so it is the `overlay`
                      rung with the scheme-tinted overlay shadow — not an
                      amber-edged translucent plate with a black drop. It
                      used to be bordered, washed, icon-tinted AND
                      word-tinted in the signal colour: four accents on one
                      transient card, while the armed tool had to make do
                      with the same hue. The one signal mark it keeps is the
                      verb it is teaching. */}
                  <div className="flex items-start gap-(--gap-group) rounded-md border border-rule-strong bg-overlay px-3 py-2 shadow-overlay">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm border border-rule bg-well text-ink-dim"
                    >
                      <PencilLine className="size-3.5" />
                    </span>
                    {/* The prose column is BOUNDED: left to `w-max` the
                        card grew to the stage's full width and pushed its
                        own verbs under the view strip at 1280. A teaching
                        card is a paragraph, not a banner. */}
                    <div className="min-w-0 max-w-[22rem]">
                      <p className="text-ui text-ink">
                        Start a sketch to build geometry — draw a profile, then{" "}
                        <span className="font-medium text-signal">Extrude</span>
                        .
                      </p>
                      <p className="mt-0.5 text-label text-ink-dim">
                        The guide plate is your starter document. Or press{" "}
                        <KeyCap>Ctrl+K</KeyCap> and run “Sketch workspace” — or
                        skip the sketch with a primitive (“Add a box”, sphere,
                        cylinder, cone).
                      </p>
                    </div>
                    <ToolGroup
                      className="shrink-0"
                      label="Getting started"
                      separated={false}
                    >
                      <ToolButton
                        data-testid="workbench-sketch-hint-start"
                        onClick={() => {
                          setMode("sketch");
                        }}
                        size="sm"
                      >
                        Start a sketch
                      </ToolButton>
                      <ToolButton
                        data-testid="workbench-sketch-hint-primitive"
                        onClick={() => {
                          openFeatureDialog("box");
                        }}
                        size="sm"
                      >
                        Add a box
                      </ToolButton>
                      <ToolButton
                        aria-label="Dismiss the getting-started hint"
                        className="w-(--control-h) justify-center px-0"
                        data-testid="workbench-sketch-hint-dismiss"
                        onClick={dismissSketchHint}
                        size="sm"
                        title="Dismiss"
                      >
                        <X />
                      </ToolButton>
                    </ToolGroup>
                  </div>
                </div>
              ) : null}
            </>
          }
        />
      </div>
      {/* The DRO band: the viewport region's readout, edge to edge along
          its bottom — the same honest engine numbers the machine surfaces
          carry (scene kind, extents, volume, triangles), plus the settle
          lamp and the live tool state. Never a second source of truth. In
          the dark register the band reads as an emissive instrument: amber
          digits over near-black glass (the cockpit's glance-mark); light
          stays plain ink on paper. */}
      <div
        className="flex h-7 shrink-0 items-center gap-(--gap-group) overflow-hidden border-t border-rule bg-well px-(--pad-panel) font-mono text-data whitespace-nowrap text-ink-dim"
        data-testid="viewport-dro"
      >
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${
            showingPreview || applied === null
              ? "bg-signal motion-safe:animate-pulse"
              : "bg-status-ok"
          }`}
        />
        {/* The static facts: the band's shrinkable half. */}
        <div className="flex min-w-0 items-center gap-(--gap-group) overflow-hidden">
          {showingPreview ? (
            <>
              <span className="text-ink tabular">
                import · {ioSurface.preview?.source ?? ""}
              </span>
              <span>
                tris{" "}
                <span className={DRO_VALUE}>
                  {ioSurface.preview === null
                    ? "…"
                    : String(ioSurface.preview.triangles)}
                </span>
              </span>
              <span>
                vol{" "}
                <span className={DRO_VALUE}>
                  {ioSurface.preview === null
                    ? "…"
                    : `${ioSurface.preview.volumeText} mm³`}
                </span>
              </span>
              <span>geometry only, not in the document</span>
            </>
          ) : applied === null ? (
            <span className="text-ink tabular">computing…</span>
          ) : (
            <>
              <span className="text-ink tabular">{engine.activeScene}</span>
              <span>
                extents{" "}
                <span className={DRO_VALUE}>
                  {formatBoundsExtents(applied.state.measurement.bounds)}
                </span>
              </span>
              <span>
                vol{" "}
                <span className={DRO_VALUE}>
                  {`${applied.state.measurement.volume.toFixed(3)} mm³`}
                </span>
              </span>
              <span>
                tris{" "}
                <span className={DRO_VALUE}>
                  {String(applied.state.measurement.triangles)}
                </span>
              </span>
            </>
          )}
        </div>
        {/* The live tool state rides the DRO's right end: what is armed,
            and how it cancels. It used to be `hidden … sm:flex` — the
            most VOLATILE fact in the band, deleted by viewport width.
            It is `shrink-0` now instead: the band's static facts (scene,
            extents, volume, triangles) give up their width first, and
            what is armed is always on screen. */}
        <span className="ml-auto flex shrink-0 items-center gap-(--gap-group)">
          {toolsApi.phase === "active" && toolsApi.activeToolId !== null ? (
            <span>
              tool{" "}
              <span className="text-ink tabular">{toolsApi.activeToolId}</span>{" "}
              · Esc cancels
            </span>
          ) : null}
          <span>
            sel{" "}
            <span className={DRO_VALUE}>
              {String(selectionApi.selected.length)}
            </span>
          </span>
        </span>
      </div>
    </div>
  );

  // The rails' default content (see ./zones/rail-slot-defaults): the slot
  // contract is unchanged — a host function slot still replaces any of
  // these wholesale — but the ELEMENTS are zone content and now live with
  // the zones.
  const defaultModelTree = modelTreeSlotDefault({
    document: workbenchDocument,
    onBodyAppearance: handleBodyAppearance,
    onBodyIsolate: handleBodyIsolate,
    onBodyVisibility: handleBodyVisibility,
    onRenameBody: setRenameBodyId,
    regenerationStates,
  });
  const defaultPropertyPanel = propertyPanelSlotDefault(regenerationStates);
  const defaultParameterPanel = parameterPanelSlotDefault();
  const defaultConfigurationPanel = configurationPanelSlotDefault({
    activeConfigurationId: engine.activeConfigurationId,
    document: workbenchDocument,
    notice: csvImportReadError ?? engine.configurationNotice,
    onClearReadError: () => {
      setCsvImportReadError(null);
    },
    onCreate: engine.createConfiguration,
    onDelete: (id) => {
      engine.deleteConfiguration(createConfigurationId(id));
    },
    onExportCsv: engine.exportParameterTableCsv,
    onImportCsv: engine.importParameterTableCsv,
    onReadError: setCsvImportReadError,
    onSwitch: (id) => {
      engine.applyConfiguration(id === null ? null : createConfigurationId(id));
    },
  });

  // The band owns the bottom rule and the surface, so the strip inside it
  // renders transparent and borderless (the contract documented on the
  // `statusBar` slot).
  const defaultStatusBar = (
    <CompleteWorkbenchStatusBar className="min-w-0 flex-1 border-t-0 bg-transparent px-0" />
  );

  const hasIo = io !== undefined;
  const defaultIoDialogs = !hasIo ? null : (
    <>
      <CadExportDialog
        entries={ioSurface.exportEntries}
        error={ioSurface.exportError}
        finalFocus={exportTriggerRef}
        formats={ioSurface.exportFormats}
        onExport={ioSurface.onExport}
        onOpenChange={setExportDialogOpen}
        open={exportDialogOpen}
        pendingFormatId={ioSurface.exportPendingFormatId}
      />
      <CadImportDialog
        error={ioSurface.importError}
        finalFocus={importTriggerRef}
        formats={ioSurface.importFormats}
        held={ioSurface.importHeld}
        onImportFiles={ioSurface.onImportFiles}
        onOpenChange={setImportDialogOpen}
        open={importDialogOpen}
        outcome={ioSurface.importOutcome}
        pending={ioSurface.importPending}
      />
    </>
  );

  // -- Slot resolution: a function slot replaces its default entirely -------

  const barNode = slots.bar?.(context);
  const toolbar = slots.toolbar?.(context) ?? defaultToolbar;
  const historyTimeline =
    slots.historyTimeline?.(context) ?? defaultHistoryTimeline;
  const commandMenu = slots.commandMenu?.(context) ?? defaultCommandMenu;
  const viewport = slots.viewport?.(context) ?? defaultViewport;
  const modelTree = slots.modelTree?.(context) ?? defaultModelTree;
  const propertyPanel = slots.propertyPanel?.(context) ?? defaultPropertyPanel;
  const parameterPanel =
    slots.parameterPanel?.(context) ?? defaultParameterPanel;
  const configurationPanel =
    slots.configurationPanel?.(context) ?? defaultConfigurationPanel;
  const statusBar = slots.statusBar?.(context) ?? defaultStatusBar;
  const ioDialogs = slots.ioDialogs?.(context) ?? defaultIoDialogs;

  // -- The TOP zones' inputs ------------------------------------------------

  // The document facts every strip verb's enablement reads. The strip
  // states each verb's precondition in its own title; the composition only
  // says what is true of the document.
  const stripAvailability: WorkbenchStripAvailability = {
    canAuthorSketchFeatures,
    bodyCount: featureProducedBodies.length,
    datumPlaneCount: datumPlaneOptions.length,
    hasExtrudeBase,
    hasFaceSelection,
    hasQuickHoleBase: holeBase !== undefined,
    sheetCount: sheetOptions.length,
    sketchCount: sketchOptions.length,
  };

  // The file cluster exists only when the host wired adapters — the strip
  // never pretends to exchange files it has none for.
  const stripIo: WorkbenchStripIo | null = !hasIo
    ? null
    : {
        canExport: applied !== null,
        exportTriggerRef,
        importTriggerRef,
        onExport: () => {
          setExportDialogOpen(true);
        },
        onImport: () => {
          setImportDialogOpen(true);
        },
      };

  // TOP′: the armed tool's options, or null while nothing is armed.
  const armedToolOptions = describeArmedTool({
    onCancel: toolsApi.cancel,
    onClearSelection: selectionApi.clear,
    phase: toolsApi.phase,
    selectionCount: selectionApi.selected.length,
    toolId: toolsApi.activeToolId,
  });

  // The measurement readouts (the same engine derivations the Phase 15
  // page shows; see ./measurement-section).
  const measureText = engine.measureText;
  const referenceDistance = engine.referenceDistance;
  const distanceText =
    referenceDistance.text ??
    (measureText === null ? null : `${measureText} mm`);
  const distanceSource =
    referenceDistance.text !== null
      ? referenceDistance.source
      : measureText !== null
        ? "point pair"
        : null;

  const heldExportsJson = JSON.stringify(
    Object.fromEntries(
      ioSurface.exportEntries.map((entry) => [entry.formatId, entry.byteCount]),
    ),
  );

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-x-clip"
      data-command-log={JSON.stringify(engine.store.commandLog)}
      data-command-menu-open={String(commandMenuOpen)}
      data-export-dialog-open={String(exportDialogOpen)}
      data-export-error={ioSurface.exportError}
      data-export-held={heldExportsJson}
      data-curve-count={String(workbenchDocument.curves.length)}
      data-curves={curvesJson}
      data-configurations={engine.configurationsJson}
      data-datum-count={String(
        (datumsJson === "[]" ? [] : (JSON.parse(datumsJson) as unknown[]))
          .length,
      )}
      data-datums={datumsJson}
      data-face-anchors={engine.faceAnchors}
      data-feature-dialog-kind={featureDialog ?? ""}
      data-feature-dialog-open={String(featureDialog !== null)}
      data-feature-timeline={timelineJson}
      data-history={JSON.stringify({
        canUndo: historyApi.canUndo,
        canRedo: historyApi.canRedo,
        cursor: historyApi.cursor,
        depth: historyApi.depth,
      })}
      data-hole-diameter={storedHole === null ? "" : String(storedHole)}
      data-import-dialog-open={String(importDialogOpen)}
      data-import-error={ioSurface.importError}
      data-import-source={ioSurface.preview?.source ?? ""}
      data-import-triangles={
        ioSurface.preview === null ? "" : String(ioSurface.preview.triangles)
      }
      data-import-volume={ioSurface.preview?.volumeText ?? ""}
      data-import-detail={ioSurface.preview?.detailJson ?? ""}
      data-imported-frames={String(importedFrames)}
      data-rendered-frames={String(engine.renderedFrames)}
      data-scene-kind={engine.activeScene}
      data-scene-extents={
        applied === null
          ? ""
          : formatBoundsExtents(applied.state.measurement.bounds)
      }
      data-selection={JSON.stringify(
        selectionApi.selected.map(serializeSelectionReference),
      )}
      data-selection-key={selectionApi.selected
        .map(selectionReferenceKey)
        .join(";")}
      data-selection-regeneration={String(selectionApi.regeneration)}
      data-sketch-hint={sketchHintOpen ? "open" : "dismissed"}
      data-sketch-mode={mode}
      data-tool-completion={
        toolsApi.completion === null ? "" : completionJson(toolsApi.completion)
      }
      data-tool-failure={
        toolsApi.failure === null ? "" : JSON.stringify(toolsApi.failure)
      }
      data-tool-id={toolsApi.activeToolId ?? ""}
      data-tool-phase={toolsApi.phase}
      data-tool-state={JSON.stringify(toolsApi.toolState)}
      data-viewport-showing={showingPreview ? "import" : "document"}
      data-viewport-camera-source={
        viewSession.userCamera === null ? "spec" : "user"
      }
      data-viewport-display-mode={viewSession.displayMode}
      data-viewport-convention={viewSession.convention}
      id={rootId}
    >
      {/* The host's page-level bar (the document route's persistence
          chrome) when a slot supplies one; the bare route renders nothing
          here, keeping its DOM unchanged. Same wrapper band the shared
          WorkbenchLayout wraps its bar in. */}
      {barNode === undefined ? null : (
        <div className="shrink-0 border-b border-rule bg-chrome">{barNode}</div>
      )}
      {/* TOP — the icon tool strip. The nineteen text verbs, the three
          tiers of width-conditional hiding and the hand-rolled group
          dividers are gone: the zone owns the strip, and this composition
          owns only the document facts the verbs read and the operations
          they run. In sketch mode it yields to the sketch editor's own
          command row; the model surfaces stay MOUNTED but hidden so the
          session's surface writer keeps their ids. */}
      <WorkbenchToolStrip
        availability={stripAvailability}
        canRedo={historyApi.canRedo}
        canUndo={historyApi.canUndo}
        commandMenu={commandMenu}
        hidden={mode === "sketch"}
        io={stripIo}
        onEnterSketch={() => {
          setMode("sketch");
        }}
        onFeatureDialog={openFeatureDialog}
        onQuickHole={handleHole}
        onRedo={historyApi.redo}
        onSketchOnFace={sketchOnSelectedFace}
        onUndo={historyApi.undo}
        toolbar={toolbar}
      />
      {/* TOP′ — the armed tool's own options strip. Present only while a
          tool is live, and never in sketch mode (whose strip is step 4's). */}
      {mode === "sketch" ? null : (
        <ToolOptionsBar descriptor={armedToolOptions} />
      )}
      {mode === "sketch" ? (
        <SketchMode
          bootWorkplane={sketchBootWorkplane ?? undefined}
          key={
            sketchBootWorkplane === null ? "xy" : sketchBootWorkplane.origin.x
          }
          onExit={() => {
            setMode("model");
          }}
          onExtrude={handleExtrude}
          importSketchFiles
          onRevolve={handleRevolve}
          onSaveSketch={handleSaveSketch}
          parameters={workbenchDocument.parameters}
        />
      ) : null}
      {/* The workspace: an edge-to-edge machine bed. LEFT rail flush
          left, the viewport owning every remaining pixel, RIGHT rail
          flush right — regions divided by hairlines, not floating cards.
          Both rails are real zone components now, in the flex flow at
          every width, each with its own collapse state; the off-canvas
          drawer, the `xl:hidden` scrim and the `invisible` tab-order
          dance are deleted. Hidden (not unmounted) in sketch mode. */}
      <div
        className={`relative min-h-0 flex-1 overflow-hidden ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        <WorkbenchModelRail
          collapsed={rails.isCollapsed("model")}
          datums={railDatums}
          isSectionOpen={rails.isSectionOpen}
          modelTree={modelTree}
          onSectionOpenChange={rails.setSectionOpen}
          onToggleCollapsed={() => {
            rails.toggleCollapsed("model");
          }}
          sketches={sketchOptions}
        />
        {viewport}
        <WorkbenchInspectorRail
          collapsed={rails.isCollapsed("inspector")}
          configurationPanel={configurationPanel}
          document={workbenchDocument}
          isSectionOpen={rails.isSectionOpen}
          measurementSection={
            <WorkbenchMeasurementSection
              boundsState={engine.boundsState}
              distanceSource={distanceSource}
              distanceText={distanceText}
              hideHeader
              massPropertiesState={engine.massPropertiesState}
              radiusState={engine.radiusState}
              sectionClipped={engine.sectionClipped}
              sectionState={engine.sectionState}
              sectionViewMode={engine.sectionViewMode}
              onToggleSectionClipped={engine.toggleSectionClipped}
              onToggleSectionViewMode={engine.toggleSectionViewMode}
            />
          }
          mode={mode}
          onSectionOpenChange={rails.setSectionOpen}
          onToggleCollapsed={() => {
            rails.toggleCollapsed("inspector");
          }}
          onViewChange={setAgentChatView}
          parameterPanel={parameterPanel}
          propertyPanel={propertyPanel}
          selection={selectionApi.selection}
          selectionCount={selectionApi.selected.length}
          sessionSlot={agentChatSessionSlot}
          toolsSurface={agentToolsSurface}
          view={agentChatView}
        />
      </div>
      {/* The feature band: the document's history as its own full-width
          row between the workspace and the status bar (hidden, like every
          model surface, in sketch mode). The timeline's chips and health
          counter are the same joined-status surfaces as ever — only their
          host row changed. */}
      <div className={mode === "sketch" ? "hidden" : "contents"}>
        {historyTimeline}
      </div>
      {/* BOTTOM — the status band: the settle lamp as a real StatusDot in
          normal flow (the `[&_[data-slot='cad-status-bar']]:pl-9`
          reach-in is deleted), the document plate brought down from the
          tool strip, and the statusBar slot's node. */}
      <WorkbenchStatusBand
        extentsText={
          applied === null
            ? null
            : formatBoundsExtents(applied.state.measurement.bounds)
        }
        featureCount={timeline === null ? null : timeline.length}
        hidden={mode === "sketch"}
        sceneKind={showingPreview ? "import" : engine.activeScene}
        settled={settled}
        statusBar={statusBar}
      />
      {ioDialogs}
      {/* The Phase 38 feature dialog: one kind-switched surface hosting the
          Formedible sweep/loft forms; a structured refusal surfaces verbatim
          in the error region and the dialog stays open (the import dialog's
          failure discipline). The dialog MOUNTS ONLY WHEN OPEN — the io
          dialogs' `if (!open) return null` discipline (see
          `cad-io-dialog.tsx`): a closed Base UI dialog renders nothing, so
          its Root never enters the server-rendered tree. That discipline is
          load-bearing here: the dialog opens only from a client interaction,
          and a server-mounted `Dialog.Root` (even closed) breaks the route's
          SSR — Base UI's store-batching hooks ride the
          `use-sync-external-store` shim, whose CJS factory re-requires
          `react` at runtime (a second React instance beside the bundled one
          the SSR renderer drives) → "Invalid hook call" → the whole route
          degrades to the client-only shell. (The bundler-level cure has
          since landed: vite.config.ts aliases the shim subpaths onto the
          single bundled React, so a stray server-mounted Root no longer
          explodes — the discipline stands regardless: a closed dialog has
          nothing to render server-side.) */}
      {featureDialog !== null && topologyPickDialog === null ? (
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setFeatureDialog(null);
              setHoleDialogValues(null);
            }
          }}
          open
        >
          <DialogContent
            className="sm:max-w-md"
            data-testid="feature-form-dialog"
          >
            <DialogHeader>
              <DialogTitle>
                {featureDialog === "surface-create"
                  ? "Create base sheet"
                  : featureDialog === "surface-trim"
                    ? "Trim sheet"
                    : featureDialog === "surface-thicken"
                      ? "Thicken sheet"
                      : featureDialog === "surface-knit"
                        ? "Knit sheets"
                        : featureDialog === "surface-offset"
                          ? "Offset sheet"
                          : featureDialog === "sweep"
                            ? CAD_FEATURE_FORM_LABELS.sweepTitle
                            : featureDialog === "loft"
                              ? CAD_FEATURE_FORM_LABELS.loftTitle
                              : featureDialog === "helix"
                                ? CAD_FEATURE_FORM_LABELS.helixTitle
                                : featureDialog === "thread"
                                  ? CAD_FEATURE_FORM_LABELS.threadTitle
                                  : featureDialog === "draft"
                                    ? CAD_FEATURE_FORM_LABELS.draftTitle
                                    : featureDialog === "rib"
                                      ? CAD_FEATURE_FORM_LABELS.ribTitle
                                      : featureDialog === "scale"
                                        ? CAD_FEATURE_FORM_LABELS.scaleTitle
                                        : featureDialog === "thicken"
                                          ? CAD_FEATURE_FORM_LABELS.thickenTitle
                                          : featureDialog === "split"
                                            ? CAD_FEATURE_FORM_LABELS.splitTitle
                                            : featureDialog === "hole"
                                              ? CAD_FEATURE_FORM_LABELS.holeTitle
                                              : featureDialog === "pattern"
                                                ? CAD_FEATURE_FORM_LABELS.patternTitle
                                                : featureDialog ===
                                                    "patternPath"
                                                  ? CAD_FEATURE_FORM_LABELS.patternPathTitle
                                                  : featureDialog === "mirror"
                                                    ? CAD_FEATURE_FORM_LABELS.mirrorTitle
                                                    : featureDialog ===
                                                        "boolean"
                                                      ? CAD_FEATURE_FORM_LABELS.booleanTitle
                                                      : featureDialog ===
                                                          "moveBody"
                                                        ? CAD_FEATURE_FORM_LABELS.moveBodyTitle
                                                        : isPrimitiveKind(
                                                              featureDialog,
                                                            )
                                                          ? primitiveFormTitle(
                                                              featureDialog,
                                                            )
                                                          : featureDialog ===
                                                              "duplicate"
                                                            ? CAD_FEATURE_FORM_LABELS.duplicateTitle
                                                            : featureDialog ===
                                                                "curve"
                                                              ? CURVE_FORM_LABELS.title
                                                              : DATUM_FORM_LABELS.title}
              </DialogTitle>
            </DialogHeader>
            <p className="text-body text-ink-dim">
              {featureDialog === "surface-create"
                ? "Bind an untrimmed plane patch to a datum plane: the base sheet the surface operations reshape."
                : featureDialog === "surface-trim"
                  ? "Trim one sheet by another: keep or cut the tool's region (the surfaceOps family)."
                  : featureDialog === "surface-thicken"
                    ? "Thicken a sheet into a solid: a wall on the picked side of the surface."
                    : featureDialog === "surface-knit"
                      ? "Sew two or more sheets along their shared edges; a boundary-consistent knit closes into a solid."
                      : featureDialog === "surface-offset"
                        ? "Move the sheet's surface along its normals by a signed distance, keeping it open."
                        : featureDialog === "sweep"
                          ? CAD_FEATURE_FORM_LABELS.sweepHint
                          : featureDialog === "loft"
                            ? CAD_FEATURE_FORM_LABELS.loftHint
                            : featureDialog === "helix"
                              ? CAD_FEATURE_FORM_LABELS.helixHint
                              : featureDialog === "thread"
                                ? CAD_FEATURE_FORM_LABELS.threadHint
                                : featureDialog === "rib"
                                  ? CAD_FEATURE_FORM_LABELS.ribHint
                                  : featureDialog === "scale"
                                    ? CAD_FEATURE_FORM_LABELS.scaleHint
                                    : featureDialog === "thicken"
                                      ? CAD_FEATURE_FORM_LABELS.thickenHint
                                      : featureDialog === "split"
                                        ? CAD_FEATURE_FORM_LABELS.splitHint
                                        : featureDialog === "hole"
                                          ? CAD_FEATURE_FORM_LABELS.holeHint
                                          : featureDialog === "pattern"
                                            ? CAD_FEATURE_FORM_LABELS.patternHint
                                            : featureDialog === "patternPath"
                                              ? CAD_FEATURE_FORM_LABELS.patternPathHint
                                              : featureDialog === "mirror"
                                                ? CAD_FEATURE_FORM_LABELS.mirrorHint
                                                : featureDialog === "boolean"
                                                  ? CAD_FEATURE_FORM_LABELS.booleanHint
                                                  : featureDialog === "moveBody"
                                                    ? CAD_FEATURE_FORM_LABELS.moveBodyHint
                                                    : isPrimitiveKind(
                                                          featureDialog,
                                                        )
                                                      ? CAD_FEATURE_FORM_LABELS.primitiveHint
                                                      : featureDialog ===
                                                          "duplicate"
                                                        ? CAD_FEATURE_FORM_LABELS.duplicateHint
                                                        : featureDialog ===
                                                            "curve"
                                                          ? CURVE_FORM_LABELS.hint
                                                          : DATUM_FORM_LABELS.hint}
            </p>
            {featureDialog === "surface-create" ? (
              <CreateSheetForm
                datums={datumPlaneOptions}
                onCreateSheet={submitCreateSheet}
                parameterNames={parameterNameOptions}
              />
            ) : featureDialog === "surface-trim" ? (
              <TrimSurfaceForm
                sheets={sheetOptions}
                onTrim={submitTrimSurface}
              />
            ) : featureDialog === "surface-thicken" ? (
              <ThickenSurfaceForm
                sheets={sheetOptions}
                onThickenSurface={submitThickenSurface}
                parameterNames={parameterNameOptions}
              />
            ) : featureDialog === "surface-knit" ? (
              <KnitSurfaceForm
                sheets={sheetOptions}
                onKnit={submitKnitSurface}
                parameterNames={parameterNameOptions}
              />
            ) : featureDialog === "surface-offset" ? (
              <OffsetSurfaceForm
                sheets={sheetOptions}
                onOffset={submitOffsetSurface}
                parameterNames={parameterNameOptions}
              />
            ) : featureDialog === "sweep" ? (
              <SweepFeatureForm
                onSweep={submitSweep}
                sketches={sketchOptions}
              />
            ) : featureDialog === "loft" ? (
              <LoftFeatureForm onLoft={submitLoft} sketches={sketchOptions} />
            ) : featureDialog === "helix" ? (
              <HelixFeatureForm
                datumAxes={datumAxisOptions}
                onHelix={submitHelix}
                parameterNames={parameterNameOptions}
                sketches={sketchOptions}
              />
            ) : featureDialog === "thread" ? (
              <ThreadFeatureForm
                onThread={submitThread}
                parameterNames={parameterNameOptions}
              />
            ) : featureDialog === "draft" ? (
              <DraftFeatureForm
                onDraft={submitDraft}
                parameterNames={parameterNameOptions}
                sketches={sketchOptions}
              />
            ) : featureDialog === "rib" ? (
              <RibFeatureForm
                onRib={submitRib}
                parameterNames={parameterNameOptions}
                sketches={sketchOptions}
              />
            ) : featureDialog === "scale" ? (
              <ScaleFeatureForm
                onScale={submitScale}
                parameterNames={parameterNameOptions}
              />
            ) : featureDialog === "thicken" ? (
              <ThickenFeatureForm
                onThicken={submitThicken}
                parameterNames={parameterNameOptions}
              />
            ) : featureDialog === "split" ? (
              <SplitFeatureForm
                datumPlanes={datumPlaneOptions}
                onSplit={submitSplit}
              />
            ) : featureDialog === "hole" ? (
              <HoleFeatureForm
                datumAxes={datumAxisOptions}
                onHole={submitStructuredHole}
                onValuesChange={setHoleDialogValues}
                parameterNames={parameterNameOptions}
                sketches={sketchOptions}
              />
            ) : featureDialog === "pattern" ? (
              <PatternFeatureForm onPattern={submitPattern} />
            ) : featureDialog === "patternPath" ? (
              <PatternPathFeatureForm
                onPatternPath={submitPatternPath}
                sketches={sketchOptions}
              />
            ) : featureDialog === "mirror" ? (
              <MirrorFeatureForm
                datumPlanes={datumPlaneOptions}
                onMirror={submitMirror}
              />
            ) : featureDialog === "boolean" ? (
              <BooleanFeatureForm
                bodies={featureProducedBodies}
                onBoolean={submitBoolean}
              />
            ) : featureDialog === "moveBody" ? (
              <MoveBodyFeatureForm onMoveBody={submitMoveBody} />
            ) : isPrimitiveKind(featureDialog) ? (
              <PrimitiveFeatureForm
                key={featureDialog}
                kind={featureDialog}
                onPrimitive={submitPrimitive}
              />
            ) : featureDialog === "duplicate" ? (
              <DuplicateFeatureForm
                bodies={duplicateBodies}
                onDuplicate={submitDuplicate}
                parameterNames={parameterNameOptions}
              />
            ) : featureDialog === "curve" ? (
              <CurveFeatureForm onCreateCurve={submitCurve} />
            ) : (
              <DatumFeatureForm
                onCreateDatum={(payload) => {
                  const outcome = handleCreateDatum(payload);
                  setFeatureOutcome(outcome);
                  if (outcome.ok) setFeatureDialog(null);
                }}
              />
            )}
            {featureOutcome !== null && !featureOutcome.ok ? (
              <div
                className="text-destructive border-destructive/40 rounded-sm border px-2 py-1.5 text-xs leading-4"
                data-testid="feature-form-error"
                role="alert"
              >
                {`${featureOutcome.code}: ${featureOutcome.message}`}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
      {/* The Phase 44 body rename dialog: mount-if-open, the feature
          dialog's SSR discipline verbatim. */}
      {renameBody !== null ? (
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setRenameBodyId(null);
              setFeatureOutcome(null);
            }
          }}
          open
        >
          <DialogContent
            className="sm:max-w-sm"
            data-testid="body-rename-dialog"
          >
            <DialogHeader>
              <DialogTitle>
                {CAD_FEATURE_FORM_LABELS.renameBodyTitle}
              </DialogTitle>
            </DialogHeader>
            <BodyRenameForm
              currentName={renameBody.name}
              onRename={(name) => {
                const outcome = handleBodyRename(renameBody.id, name);
                setFeatureOutcome(outcome);
                if (outcome.ok) {
                  setRenameBodyId(null);
                  setFeatureOutcome(null);
                }
              }}
            />
            {featureOutcome !== null && !featureOutcome.ok ? (
              <div
                className="text-destructive border-destructive/40 rounded-sm border px-2 py-1.5 text-xs leading-4"
                data-testid="feature-form-error"
                role="alert"
              >
                {`${featureOutcome.code}: ${featureOutcome.message}`}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
