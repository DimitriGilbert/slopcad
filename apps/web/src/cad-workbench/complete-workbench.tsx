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
import type { ReactElement, ReactNode } from "react";
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
import {
  Command,
  Download,
  PanelLeft,
  PanelRight,
  PencilLine,
  Redo2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
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
import { CadModelTree } from "@slopcad/ui/components/cad/cad-model-tree";
import { CadParameterPanel } from "@slopcad/ui/components/cad/cad-parameter-panel";
import { CadConfigurationPanel } from "@slopcad/ui/components/cad/cad-configuration-panel";
import type { CadConfigurationRow } from "@slopcad/ui/components/cad/cad-configuration-panel";
import { CadPropertyPanel } from "@slopcad/ui/components/cad/cad-property-panel";
import { CadStatusBar } from "@slopcad/ui/components/cad/cad-status-bar";
import { CadToolbar } from "@slopcad/ui/components/cad/cad-toolbar";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import type { RenderCamera, RenderProjection } from "@slopcad/cad-core";
import type { FixtureSessionBackendId } from "../render-fixture/session-backend";
import type { CurveAuthoring } from "./curves";
import type { LoftSectionChoice } from "./loft";
import { clippingPlanesOf } from "@slopcad/cad-r3f";
import type { AgentToolsSurface } from "../agent/tools";

import { useWorkbenchWebMcpTools } from "../webmcp/workbench-tools";
import { executeWebMcpTool } from "../webmcp/registry";
import { completionJson } from "../render-fixture/fixture-session";
import { createAgentChatCommands } from "../agent/chat/chat-commands";
import {
  createAgentChatSessionSlot,
  useAgentChatSession,
} from "../agent/chat/session-slot";
import { useAgentChatView } from "../agent/chat/view-state";
import { WorkbenchRightSidebar } from "./right-sidebar";
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
  /** The command row's tool strip. */
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
  /** The bottom status bar. */
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

/** Labels of the composition's own chrome (non-component strings). */
const LABELS = {
  commandMenuTrigger: "Commands",
  commandMenuHint: "Ctrl+K",
  import: "Import",
  export: "Export",
} as const;

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
 * The DRO's value ink. In the dark register the digits read as an emissive
 * machine readout — amber over the near-black band with a soft glow — the
 * cockpit's glance-mark; in light the values are plain instrument ink on
 * paper and nothing glows.
 */
const DRO_VALUE =
  "text-foreground dark:text-signal dark:[text-shadow:0_0_12px_color-mix(in_oklch,var(--signal)_35%,transparent)]";

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
    | null
  >(null);
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
  // Below the dock breakpoint the docks become overlay drawers: one DOM
  // instance per dock, slid in and out by transform, returned to the flex
  // flow at `xl` — so the machine surfaces never unmount at any width.
  const [treeDrawerOpen, setTreeDrawerOpen] = useState(false);
  const [panelsDrawerOpen, setPanelsDrawerOpen] = useState(false);
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
  // A scrimmed overlay answers Escape: an open drawer closes on the key at
  // window level — unless a tool is live, because the viewport's documented
  // Escape surface (cancel the armed tool) owns the key first.
  useEffect(() => {
    if (!treeDrawerOpen && !panelsDrawerOpen) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      // A genuinely armed tool (not the resting select) owns Escape first —
      // the viewport's documented cancel surface.
      if (toolsApi.phase === "active" && toolsApi.activeToolId !== "select") {
        return;
      }
      setTreeDrawerOpen(false);
      setPanelsDrawerOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [panelsDrawerOpen, toolsApi.activeToolId, toolsApi.phase, treeDrawerOpen]);

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
        | "duplicate",
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

  // The WebMCP binding (Phase 7 + the Phase 2.1 capture tool): the eleven
  // workbench tools registered for the page's lifetime — always in the
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

  const defaultHistoryTimeline = (
    <div
      aria-label="Feature timeline"
      className="border-border bg-card/40 flex h-9 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-t px-3"
      data-testid="complete-feature-timeline"
      role="group"
    >
      <span className="text-muted-foreground shrink-0 font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
        Timeline
      </span>
      {timeline === null ? (
        <span className="text-muted-foreground shrink-0 text-xs">
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
      <Button
        aria-label="Open the command menu (Ctrl+K)"
        data-testid="complete-command-menu-trigger"
        onClick={() => {
          setCommandMenuOpen(true);
        }}
        size="xs"
        title="Open the command menu (Ctrl+K)"
        type="button"
        variant="outline"
      >
        {/* Below `xl` the row sheds labels before it ever clips a control:
            the trigger collapses to its mark, the hint lives in the title. */}
        <Command aria-hidden="true" className="xl:hidden" />
        <span className="max-xl:hidden">{LABELS.commandMenuTrigger}</span>
        <kbd
          aria-hidden="true"
          className="border-current/40 border max-xl:hidden px-1 font-mono text-[10px] font-normal leading-4"
        >
          {LABELS.commandMenuHint}
        </kbd>
      </Button>
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
      <div className="relative min-h-0 flex-1">
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
                <span className="border-muted-foreground absolute top-1.5 left-1.5 size-2.5 border-t border-l" />
                <span className="border-muted-foreground absolute top-1.5 right-1.5 size-2.5 border-t border-r" />
                <span className="border-muted-foreground absolute bottom-1.5 left-1.5 size-2.5 border-b border-l" />
                <span className="border-muted-foreground absolute right-1.5 bottom-1.5 size-2.5 border-r border-b" />
              </div>
              {showingPreview ? (
                <div className="pointer-events-auto absolute top-2 left-2 flex items-center gap-2 rounded-sm border border-border bg-background/95 px-2 py-1 text-xs shadow-sm">
                  <span className="text-muted-foreground font-mono text-[11px]">
                    {`preview: ${ioSurface.preview?.source ?? ""} mesh: geometry only, not in the document`}
                  </span>
                  <Button
                    data-testid="complete-clear-import"
                    onClick={ioSurface.onClearPreview}
                    size="xs"
                    type="button"
                    variant="outline"
                  >
                    Back to model
                  </Button>
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
              {sketchOnFaceNote !== null ? (
                <div
                  className="border-destructive/40 bg-background/95 text-destructive absolute top-2 right-2 max-w-sm rounded-sm border px-2 py-1 text-xs leading-4"
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
              {!showingPreview && !sketchHintDismissed ? (
                <div
                  className="pointer-events-auto absolute bottom-3 left-1/2 w-max max-w-[calc(100%-1rem)] -translate-x-1/2"
                  data-testid="workbench-sketch-hint"
                >
                  <div className="border-signal/40 bg-background/95 flex items-start gap-2.5 rounded-md border px-3 py-2 shadow-lg shadow-black/25">
                    <span
                      aria-hidden="true"
                      className="border-signal/40 bg-signal/15 text-signal mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-sm border"
                    >
                      <PencilLine className="size-3.5" />
                    </span>
                    <div className="min-w-0">
                      <p className="text-foreground text-xs leading-snug">
                        Start a sketch to build geometry — draw a profile, then{" "}
                        <span className="text-signal font-medium">Extrude</span>
                        .
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
                        The guide plate is your starter document. Or press{" "}
                        <kbd className="border-current/40 border px-1 font-mono text-[10px]">
                          Ctrl+K
                        </kbd>{" "}
                        and run “Sketch workspace”.
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        className="border-signal/50 hover:bg-signal/10"
                        data-testid="workbench-sketch-hint-start"
                        onClick={() => {
                          setMode("sketch");
                        }}
                        size="xs"
                        type="button"
                        variant="outline"
                      >
                        Start a sketch
                      </Button>
                      <Button
                        aria-label="Dismiss the getting-started hint"
                        data-testid="workbench-sketch-hint-dismiss"
                        onClick={dismissSketchHint}
                        size="icon-xs"
                        title="Dismiss"
                        type="button"
                        variant="ghost"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </div>
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
        className="border-border bg-card/50 text-muted-foreground dark:border-signal/20 dark:bg-black/60 flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t px-3 font-mono text-[11px] whitespace-nowrap"
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
        {showingPreview ? (
          <>
            <span className="text-signal dark:[text-shadow:0_0_12px_color-mix(in_oklch,var(--signal)_35%,transparent)]">
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
            <span className="hidden xl:inline">
              geometry only, not in the document
            </span>
          </>
        ) : applied === null ? (
          <span className="text-signal dark:[text-shadow:0_0_12px_color-mix(in_oklch,var(--signal)_35%,transparent)]">
            computing…
          </span>
        ) : (
          <>
            <span className="text-signal dark:[text-shadow:0_0_12px_color-mix(in_oklch,var(--signal)_35%,transparent)]">
              {engine.activeScene}
            </span>
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
        {/* The live tool state rides the DRO's right end: what is armed,
            and how it cancels. */}
        <span className="text-muted-foreground ml-auto hidden items-center gap-4 sm:flex">
          {toolsApi.phase === "active" && toolsApi.activeToolId !== null ? (
            <span>
              tool{" "}
              <span className="text-signal dark:[text-shadow:0_0_12px_color-mix(in_oklch,var(--signal)_35%,transparent)]">
                {toolsApi.activeToolId}
              </span>{" "}
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

  // Inside the docks the panels shed their floating-card chrome: the dock
  // IS the chrome (flush sections, hairline dividers, no radius), while the
  // components keep their standalone card look everywhere else.
  const flushPanel = "w-full shrink-0 rounded-none border-0 bg-transparent";
  const defaultModelTree =
    regenerationStates === null ? null : (
      <CadModelTree
        bodyDisplay={(bodyId) => {
          const body = workbenchDocument.bodies.find(
            (candidate) => candidate.id === bodyId,
          );
          return body === undefined
            ? undefined
            : {
                visible: body.visible !== false,
                isolated: body.isolated === true,
                appearance: body.appearance,
              };
        }}
        onBodyAction={(action) => {
          if (action.type === "rename") {
            setRenameBodyId(action.bodyId);
            return;
          }
          if (action.type === "toggle-visibility") {
            const body = workbenchDocument.bodies.find(
              (candidate) => candidate.id === action.bodyId,
            );
            if (body === undefined) return;
            handleBodyVisibility(action.bodyId, body.visible === false);
            return;
          }
          if (action.type === "appearance") {
            handleBodyAppearance(action.bodyId, action.presetId);
            return;
          }
          const body = workbenchDocument.bodies.find(
            (candidate) => candidate.id === action.bodyId,
          );
          if (body === undefined) return;
          handleBodyIsolate(action.bodyId, body.isolated !== true);
        }}
        regenerationStates={regenerationStates}
        className="w-full rounded-none border-0 bg-transparent"
      />
    );

  const defaultPropertyPanel = (
    <CadPropertyPanel
      regenerationStates={regenerationStates ?? undefined}
      className={flushPanel}
    />
  );

  const defaultParameterPanel = (
    <CadParameterPanel className="w-full min-h-0 flex-1 rounded-none border-0 bg-transparent" />
  );

  // The Phase 57 configuration surface: the switcher, the row table, the
  // Formedible create form, and the CSV row, wired to the engine's
  // configuration actions. Export writes the deterministic CSV through the
  // browser's download path; import reads the chosen file's text.
  const configurationRows: readonly CadConfigurationRow[] =
    workbenchDocument.configurations.map((configuration) => ({
      id: configuration.id,
      name: configuration.name,
      overrides: configuration.parameterOverrides.length,
      suppressed: configuration.suppressedFeatures.length,
      hidden: configuration.hiddenBodies.length,
    }));
  const defaultConfigurationPanel = (
    <CadConfigurationPanel
      configurations={configurationRows}
      activeConfigurationId={engine.activeConfigurationId}
      notice={engine.configurationNotice}
      onSwitch={(id) =>
        engine.applyConfiguration(
          id === null ? null : createConfigurationId(id),
        )
      }
      onCreate={(name) => engine.createConfiguration(name)}
      onDelete={(id) => engine.deleteConfiguration(createConfigurationId(id))}
      onExportCsv={() => {
        const csv = engine.exportParameterTableCsv();
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "parameters.csv";
        anchor.click();
        URL.revokeObjectURL(url);
        return csv;
      }}
      onImportCsv={(text) => engine.importParameterTableCsv(text)}
      className="w-full shrink-0 border-t border-border"
    />
  );

  const defaultStatusBar = <CompleteWorkbenchStatusBar />;

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
      data-sketch-hint={sketchHintDismissed ? "dismissed" : "open"}
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
        <div className="border-border bg-background shrink-0 border-b">
          {barNode}
        </div>
      )}
      {/* The command row, grouped like a machine headstock: the document
          plate (what this document IS, live), the tool group, then the
          pinned terminal actions — history, the command menu, and the
          file/mode verbs — separated by real group dividers. The feature
          timeline is NOT here: it owns its own full-width band below the
          workspace (the silhouette CAD engineers already trust), so the
          chain never competes with this row for pixels and never clips a
          control at any width. Below the dock breakpoint the two drawer
          toggles appear at the row's ends. In sketch mode it yields to
          the sketch editor's own command row; the model surfaces stay
          MOUNTED but hidden so the session's surface writer keeps their
          ids. */}
      <div
        className={`border-border bg-card/40 h-10 shrink-0 items-center gap-1 border-b pr-2 ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        {/* The drawer toggles (below xl only; display-none keeps them out
            of the tab order once the docks are inline). */}
        <Button
          aria-label="Toggle model tree"
          aria-expanded={treeDrawerOpen}
          className="xl:hidden"
          data-testid="workbench-toggle-tree"
          onClick={() => {
            setPanelsDrawerOpen(false);
            setTreeDrawerOpen((open) => !open);
          }}
          size="icon-xs"
          title="Toggle the model tree dock"
          type="button"
          variant="ghost"
        >
          <PanelLeft />
        </Button>
        {/* The document plate: scene, extents, feature count — the row's
            identity block, engraved-plate style. */}
        <div
          aria-label="Document"
          className="flex h-full shrink-0 items-center gap-2.5 pr-2 pl-1"
          role="group"
        >
          <span
            aria-hidden="true"
            className={`size-1.5 shrink-0 rounded-full ${
              applied === null
                ? "bg-signal motion-safe:animate-pulse"
                : "bg-status-ok"
            }`}
          />
          <span className="text-signal font-mono text-[11px]">
            {showingPreview ? "import" : engine.activeScene}
          </span>
          <span className="text-muted-foreground hidden font-mono text-[11px] 2xl:inline">
            {applied === null
              ? "computing…"
              : formatBoundsExtents(applied.state.measurement.bounds)}
          </span>
          <span className="text-muted-foreground hidden font-mono text-[11px] xl:inline">
            {timeline === null ? "" : `${String(timeline.length)} features`}
          </span>
        </div>
        <div aria-hidden="true" className="bg-border h-5 w-px shrink-0" />
        {toolbar}
        <div aria-hidden="true" className="bg-border h-5 w-px shrink-0" />
        <div
          aria-label="History"
          className="flex shrink-0 items-center gap-0.5"
          role="group"
        >
          <Button
            aria-label="Undo"
            disabled={!historyApi.canUndo}
            onClick={() => {
              historyApi.undo();
            }}
            size="icon-xs"
            title="Undo (the document history's cursor step)"
            type="button"
            variant="ghost"
          >
            <Undo2 />
          </Button>
          <Button
            aria-label="Redo"
            disabled={!historyApi.canRedo}
            onClick={() => {
              historyApi.redo();
            }}
            size="icon-xs"
            title="Redo (the document history's cursor step)"
            type="button"
            variant="ghost"
          >
            <Redo2 />
          </Button>
        </div>
        {commandMenu}
        {!hasIo ? null : (
          <>
            <Button
              aria-label={LABELS.import}
              data-testid="complete-import"
              onClick={() => {
                setImportDialogOpen(true);
              }}
              ref={importTriggerRef}
              size="xs"
              title="Import model files."
              type="button"
              variant="outline"
            >
              <Upload aria-hidden="true" className="xl:hidden" />
              <span className="max-xl:hidden">{LABELS.import}</span>
            </Button>
            <Button
              aria-label={LABELS.export}
              data-testid="complete-export"
              disabled={applied === null}
              onClick={() => {
                setExportDialogOpen(true);
              }}
              ref={exportTriggerRef}
              size="xs"
              title={
                applied === null
                  ? "The scene settles first; nothing is exportable before that."
                  : "Export the settled model geometry."
              }
              type="button"
              variant="outline"
            >
              <Download aria-hidden="true" className="xl:hidden" />
              <span className="max-xl:hidden">{LABELS.export}</span>
            </Button>
          </>
        )}
        {/* The hole verb is contextual (it needs an extrusion to cut), so
            below `lg` it yields its row width entirely — it stays in the
            command menu and returns with the full row. */}
        <Button
          className="max-xl:hidden"
          data-testid="complete-hole"
          disabled={holeBase === undefined}
          onClick={handleHole}
          size="xs"
          title={
            holeBase === undefined
              ? "Sketch and extrude a profile first; a hole cuts an existing solid."
              : "Cut a hole into the latest extrusion; edit its five parameters in the panel."
          }
          type="button"
          variant="outline"
        >
          Hole
        </Button>
        {/* The Phase 42 structured hole verb: the hole dialog (type,
            counterbore/countersink/taper/thread spec, sketch-point
            positions, preview ghost) — the quick Hole button's sibling.
            The full verb row with every verb present measures ~1745 px
            (measured at 1800 px, scene settled), so below 1800 px the two
            widest contextual verbs — this one and Sketch on face — yield
            their width entirely and the extruded row fits the 1600 px
            band with ~45 px slack; the command menu keeps both dialogs
            reachable everywhere (the e2e drives that path). */}
        <Button
          className="max-[1799px]:hidden"
          data-testid="complete-hole-spec"
          disabled={!hasExtrudeBase}
          onClick={() => {
            openFeatureDialog("hole");
          }}
          size="xs"
          title={
            hasExtrudeBase
              ? "Open the hole dialog: type, dimensions, thread spec, and positions (one feature, many holes)."
              : "Sketch and extrude a profile first; a hole cuts an existing solid."
          }
          type="button"
          variant="outline"
        >
          Hole spec…
        </Button>
        {/* The Phase 38 feature verbs: sweep and loft author from the
            document's SAVED sketches (at least two), so the buttons state
            their enablement condition in the title instead of pretending. */}
        <Button
          className="max-xl:hidden"
          data-testid="complete-sweep"
          disabled={!canAuthorSketchFeatures}
          onClick={() => {
            openFeatureDialog("sweep");
          }}
          size="xs"
          title={
            canAuthorSketchFeatures
              ? "Sweep a saved profile sketch along a saved path sketch."
              : "Save two sketches first (draw one, press Save, repeat); sweep picks its profile and path from the saved pool."
          }
          type="button"
          variant="outline"
        >
          Sweep
        </Button>
        <Button
          className="max-xl:hidden"
          data-testid="complete-loft"
          disabled={!canAuthorSketchFeatures}
          onClick={() => {
            openFeatureDialog("loft");
          }}
          size="xs"
          title={
            canAuthorSketchFeatures
              ? "Loft two or more saved section sketches, in order, at their stations."
              : "Save two sketches first (draw one, press Save, repeat); loft picks its ordered sections from the saved pool."
          }
          type="button"
          variant="outline"
        >
          Loft
        </Button>{" "}
        {/* The Phase 40 feature verbs: helix authors from ONE saved
            meridian sketch; thread cuts the last extrusion with a picked
            ISO specification. */}
        <Button
          className="max-xl:hidden"
          data-testid="complete-helix"
          disabled={sketchOptions.length < 1}
          onClick={() => {
            openFeatureDialog("helix");
          }}
          size="xs"
          title={
            sketchOptions.length >= 1
              ? "Sweep a saved profile sketch along an analytic helix: radius, pitch, turns, handedness, taper."
              : "Save a sketch first (draw one and press Save); the helix picks its meridian profile from the saved pool."
          }
          type="button"
          variant="outline"
        >
          Helix
        </Button>
        <Button
          className="max-xl:hidden"
          data-testid="complete-thread"
          disabled={!hasExtrudeBase}
          onClick={() => {
            openFeatureDialog("thread");
          }}
          size="xs"
          title={
            hasExtrudeBase
              ? "Cut an ISO metric thread on the latest extrusion: pick a designation, mode, and length."
              : "Sketch and extrude a profile first; a thread cuts an existing solid."
          }
          type="button"
          variant="outline"
        >
          Thread
        </Button>
        {/* The Phase 41 feature verbs: draft re-extrudes a saved sketch
            with a wall-angle taper; rib authors from a saved
            cross-section sketch and needs an extrusion to grow; scale and
            thicken act on the latest extrusion; split needs a datum plane
            and an extrusion. */}
        <Button
          className="max-2xl:hidden"
          data-testid="complete-draft"
          disabled={sketchOptions.length < 1}
          onClick={() => {
            openFeatureDialog("draft");
          }}
          size="xs"
          title={
            sketchOptions.length >= 1
              ? "Extrude a saved sketch with a draft taper: the walls lean by the angle away from the sketch plane."
              : "Save a sketch first (draw one and press Save); the draft picks its profile from the saved pool."
          }
          type="button"
          variant="outline"
        >
          Draft
        </Button>
        <Button
          className="max-2xl:hidden"
          data-testid="complete-rib"
          disabled={!(sketchOptions.length >= 1 && hasExtrudeBase)}
          onClick={() => {
            openFeatureDialog("rib");
          }}
          size="xs"
          title={
            sketchOptions.length >= 1 && hasExtrudeBase
              ? "Union a rib: pick a saved cross-section sketch and a thickness; it extrudes symmetrically into the latest extrusion."
              : "Save a sketch and extrude a profile first; a rib needs a cross-section and a part to grow."
          }
          type="button"
          variant="outline"
        >
          Rib
        </Button>
        <Button
          className="max-2xl:hidden"
          data-testid="complete-scale"
          disabled={!hasExtrudeBase}
          onClick={() => {
            openFeatureDialog("scale");
          }}
          size="xs"
          title={
            hasExtrudeBase
              ? "Scale the latest extrusion by one uniform factor about the world origin."
              : "Extrude a profile first; a scale needs a solid."
          }
          type="button"
          variant="outline"
        >
          Scale
        </Button>
        <Button
          className="max-2xl:hidden"
          data-testid="complete-thicken"
          disabled={!hasExtrudeBase}
          onClick={() => {
            openFeatureDialog("thicken");
          }}
          size="xs"
          title={
            hasExtrudeBase
              ? "Hollow the latest extrusion into a closed shell of uniform walls."
              : "Extrude a profile first; a thicken needs a solid."
          }
          type="button"
          variant="outline"
        >
          Thicken
        </Button>
        <Button
          className="max-2xl:hidden"
          data-testid="complete-split"
          disabled={!(datumPlaneOptions.length >= 1 && hasExtrudeBase)}
          onClick={() => {
            openFeatureDialog("split");
          }}
          size="xs"
          title={
            datumPlaneOptions.length >= 1 && hasExtrudeBase
              ? "Split the latest extrusion by a datum plane, keeping one side."
              : "Create a datum plane and extrude a profile first; a split needs both."
          }
          type="button"
          variant="outline"
        >
          Split
        </Button>
        {/* The Phase 43 pattern verbs: the editor arrays the last
            extrusion (asymmetric legs, skip instances), the path pattern
            distributes it along a saved sketch path, and the mirror
            reflects it about a datum plane with a merge option. */}
        <Button
          className="max-[1799px]:hidden"
          data-testid="complete-pattern"
          disabled={!hasExtrudeBase}
          onClick={() => {
            openFeatureDialog("pattern");
          }}
          size="xs"
          title={
            hasExtrudeBase
              ? "Pattern the latest extrusion: one leg per direction with its own count and spacing, instances skippable by ordinal."
              : "Extrude a profile first; a pattern needs a solid."
          }
          type="button"
          variant="outline"
        >
          Pattern
        </Button>
        <Button
          className="max-[1799px]:hidden"
          data-testid="complete-pattern-path"
          disabled={!(sketchOptions.length >= 1 && hasExtrudeBase)}
          onClick={() => {
            openFeatureDialog("patternPath");
          }}
          size="xs"
          title={
            sketchOptions.length >= 1 && hasExtrudeBase
              ? "Repeat the latest extrusion along a saved path sketch at an arc-length spacing."
              : "Save a path sketch and extrude a profile first; a path pattern needs both."
          }
          type="button"
          variant="outline"
        >
          Path pattern
        </Button>
        <Button
          className="max-[1799px]:hidden"
          data-testid="complete-mirror"
          disabled={!(datumPlaneOptions.length >= 1 && hasExtrudeBase)}
          onClick={() => {
            openFeatureDialog("mirror");
          }}
          size="xs"
          title={
            datumPlaneOptions.length >= 1 && hasExtrudeBase
              ? "Mirror the latest extrusion about a datum plane, standalone or merged with the original."
              : "Create a datum plane and extrude a profile first; a mirror needs both."
          }
          type="button"
          variant="outline"
        >
          Mirror
        </Button>
        <Button
          className="max-[1799px]:hidden"
          data-testid="complete-boolean"
          disabled={!(featureProducedBodies.length >= 2)}
          onClick={() => {
            openFeatureDialog("boolean");
          }}
          size="xs"
          title={
            featureProducedBodies.length >= 2
              ? "Combine two bodies: union, subtract, or intersect, with a keep-tool toggle."
              : "Extrude two profiles first; a boolean needs a target and a tool body."
          }
          type="button"
          variant="outline"
        >
          Boolean
        </Button>
        <Button
          className="max-[1799px]:hidden"
          data-testid="complete-move-body"
          disabled={!hasExtrudeBase}
          onClick={() => {
            openFeatureDialog("moveBody");
          }}
          size="xs"
          title={
            hasExtrudeBase
              ? "Move the latest extrusion: translate it, optionally rotating about a world axis first."
              : "Extrude a profile first; a move needs a body."
          }
          type="button"
          variant="outline"
        >
          Move
        </Button>
        {/* The Phase 49 surface verbs: the sheet family — base sheet,
            trim, thicken, knit, offset — lives in the COMMAND MENU only.
            The family is the row's widest contextual group (~314 px
            together) and every harness width is already spent (the full
            verb row measures ~1745 px at 1800 px), so no tier shows the
            family without overflowing the engraved row budget; the menu
            keeps each verb reachable everywhere (the hole-spec
            discipline; the e2e drives that path). */}{" "}
        {/* The Phase 39 datum verbs: sketch-on-face needs a selected face;
            the datum form needs nothing. Both stay in the command menu on
            narrow rows. Sketch-on-face is the row's widest contextual verb
            (it needs a prior selection to mean anything), so below 1800 px
            it yields its width entirely — the same tier as the Hole spec…
            verb — and the command menu keeps it reachable everywhere (the
            e2e drives that path). */}
        <Button
          className="max-[1799px]:hidden"
          data-testid="complete-sketch-on-face"
          disabled={!hasFaceSelection}
          onClick={sketchOnSelectedFace}
          size="xs"
          title={
            hasFaceSelection
              ? "Sketch on the selected face: anchors a datum plane to it and boots the sketch editor there."
              : "Select a face in the viewport first; sketch-on-face anchors to it."
          }
          type="button"
          variant="outline"
        >
          Sketch on face
        </Button>
        <Button
          className="max-xl:hidden"
          data-testid="complete-datum"
          onClick={() => {
            openFeatureDialog("datum");
          }}
          size="xs"
          title="Create datum geometry: a plane, an axis, a point, or a coordinate system."
          type="button"
          variant="outline"
        >
          Datum
        </Button>
        {/* THE creation affordance: the one verb that adds geometry. The
            signal-amber border and mark make it the only tinted control in
            the row — the eye lands here first (the label stays foreground
            ink in every scheme; the amber rides border and icon only). */}
        <Button
          aria-label="Sketch"
          className="border-signal/60 hover:bg-signal/10"
          data-testid="complete-mode-toggle"
          onClick={() => {
            setMode("sketch");
          }}
          size="xs"
          title="Start a sketch: draw a profile, then extrude it into a solid."
          type="button"
          variant="outline"
        >
          <PencilLine aria-hidden="true" className="text-signal" />
          <span className="max-xl:hidden">Sketch</span>
        </Button>
        <Button
          aria-label="Toggle panels"
          aria-expanded={panelsDrawerOpen}
          className="xl:hidden"
          data-testid="workbench-toggle-panels"
          onClick={() => {
            setTreeDrawerOpen(false);
            setPanelsDrawerOpen((open) => !open);
          }}
          size="icon-xs"
          title="Toggle the properties and parameters dock"
          type="button"
          variant="ghost"
        >
          <PanelRight />
        </Button>
      </div>
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
      {/* The workspace: an edge-to-edge machine bed. Tree dock flush
          left, the viewport owning every remaining pixel, properties and
          parameters flush right — regions divided by hairlines, not
          floating cards. Below `xl` the docks slide out as overlay
          drawers (one DOM instance each: translated off-canvas when
          closed, returned to the flex flow at the breakpoint), and the
          viewport keeps the whole bed to itself. Hidden (not unmounted)
          in sketch mode. */}
      <div
        className={`relative flex min-h-0 flex-1 overflow-hidden ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        {/* The drawer scrim (below xl only). */}
        {(treeDrawerOpen || panelsDrawerOpen) && (
          <div
            aria-hidden="true"
            className="absolute inset-0 z-20 bg-black/40 xl:hidden"
            onClick={() => {
              setTreeDrawerOpen(false);
              setPanelsDrawerOpen(false);
            }}
          />
        )}
        {/* Left dock: the model tree over the measurement readouts, one
            scrolling column, full height. As a drawer it slides from the
            left; closed it is `invisible`, so its fields never sit in the
            tab order off-screen (visibility flips at the transition's
            end on close, start on open — the slide survives). */}
        <div
          className={`border-border bg-card absolute inset-y-0 left-0 z-30 flex w-60 shrink-0 flex-col border-r shadow-2xl transition-[transform,visibility] duration-200 xl:static xl:z-auto xl:bg-card/40 xl:shadow-none ${
            treeDrawerOpen
              ? "visible translate-x-0"
              : "invisible -translate-x-full xl:visible xl:translate-x-0"
          }`}
          data-testid="workbench-tree-dock"
        >
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {modelTree}
            <WorkbenchMeasurementSection
              boundsState={engine.boundsState}
              distanceSource={distanceSource}
              distanceText={distanceText}
              massPropertiesState={engine.massPropertiesState}
              radiusState={engine.radiusState}
              sectionClipped={engine.sectionClipped}
              sectionState={engine.sectionState}
              sectionViewMode={engine.sectionViewMode}
              onToggleSectionClipped={engine.toggleSectionClipped}
              onToggleSectionViewMode={engine.toggleSectionViewMode}
            />
          </div>
        </div>
        {viewport}
        {/* Right dock (D16, Phase 4.5): the two-view sidebar — the
            properties/parameters/configuration panels or the agent chat —
            switched by the segmented control at its top, resizable by the
            drag handle on its left edge. Same drawer discipline as the
            left dock: invisible (out of the tab order) while closed. */}
        <WorkbenchRightSidebar
          configurationPanel={configurationPanel}
          document={workbenchDocument}
          drawerOpen={panelsDrawerOpen}
          onViewChange={setAgentChatView}
          parameterPanel={parameterPanel}
          propertyPanel={propertyPanel}
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
      {/* The status frame: the settle lamp rides the status bar's left
          edge — the settle protocol made glanceable and machine-readable
          (`data-settle-lamp`). Lit (signal, soft glow in dark) while the
          rendered pixels agree with the document; a hollow ring while the
          scene settles or an import preview owns the stage. */}
      <div className="relative shrink-0 [&_[data-slot='cad-status-bar']]:pl-9">
        <span
          className="absolute left-2.5 top-1/2 z-10 -translate-y-1/2"
          data-settle-lamp={settled ? "settled" : "waiting"}
          title={
            settled
              ? "Scene settled — the rendered pixels agree with the document."
              : "Scene settling — the rendered pixels are not yet comparable."
          }
        >
          <span
            aria-hidden="true"
            className={`block size-2 transition-colors duration-200 ${
              settled
                ? "bg-signal dark:shadow-[0_0_8px_1px] dark:shadow-signal/50"
                : "border-muted-foreground/70 border"
            }`}
          />
        </span>
        {statusBar}
      </div>
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
          degrades to the client-only shell. */}
      {featureDialog !== null ? (
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
                                                        : featureDialog ===
                                                            "duplicate"
                                                          ? CAD_FEATURE_FORM_LABELS.duplicateTitle
                                                          : featureDialog ===
                                                              "curve"
                                                            ? CURVE_FORM_LABELS.title
                                                            : DATUM_FORM_LABELS.title}
              </DialogTitle>
            </DialogHeader>
            <p className="text-muted-foreground text-xs leading-snug">
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
