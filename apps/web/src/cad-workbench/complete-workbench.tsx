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
 * `data-hole-diameter`, `data-sketch-mode`), the dialog state
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
import { formatBoundsExtents } from "@slopcad/cad-core";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
import {
  CadCommandMenu,
  type CadCommandDescriptor,
} from "@slopcad/ui/components/cad/cad-command-menu";
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
import { CadPropertyPanel } from "@slopcad/ui/components/cad/cad-property-panel";
import { CadStatusBar } from "@slopcad/ui/components/cad/cad-status-bar";
import { CadToolbar } from "@slopcad/ui/components/cad/cad-toolbar";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import type { RenderProjection } from "@slopcad/cad-core";

import { completionJson } from "../render-fixture/fixture-session";
import { documentExtrudeRequest } from "./extrude";
import { documentHoleSceneRequest } from "./hole";
import { documentRevolveRequest } from "./revolve";
import { SketchMode } from "./SketchMode";
import {
  FeatureTimelineChips,
  FeatureTimelineSummary,
} from "./feature-timeline-strip";
import { WorkbenchMeasurementSection } from "./measurement-section";
import { useWorkbenchEngine, type WorkbenchEngine } from "./workbench-engine";

/** The viewport's fixed box: the determinism contract (the camera spec is
 * authored for exactly this size; the scene runs at dpr 1). */
const VIEWPORT_CLASS = "h-[520px] w-[800px]";

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
  /** The command row's tool strip. */
  readonly toolbar?: CadWorkbenchSlot;
  /** The command row's history timeline. */
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
  /** The bottom status bar. */
  readonly statusBar?: CadWorkbenchSlot;
  /** The import/export dialogs (portal-mounted). */
  readonly ioDialogs?: CadWorkbenchSlot;
}

/** Props of {@link CompleteCadWorkbench}. */
export interface CompleteCadWorkbenchProps {
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
 * The complete CAD workbench: all eight plan surfaces composed over the
 * shared engine, every piece replaceable by slot, every interaction routed
 * through the public CAD APIs.
 */
export function CompleteCadWorkbench({
  io,
  rootId = "workbench-complete-root",
  slots = {},
}: CompleteCadWorkbenchProps): ReactElement {
  const engine = useWorkbenchEngine({
    rootId,
    statusId: "workbench-complete-status",
    volumeId: "workbench-complete-volume",
    errorId: "workbench-complete-error",
  });
  const {
    applied,
    executed,
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
  } = engine;

  // Dialog + palette state: composition-owned UI state (replaced entirely
  // by the matching slot, which receives the io adapter and may own its own).
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importedFrames, setImportedFrames] = useState(0);
  // The dialog trigger buttons: the dialogs open from state (these buttons,
  // the palette's File commands), so the primitive cannot track the opener
  // itself — these refs are the documented focus-restoration points.
  const importTriggerRef = useRef<HTMLButtonElement | null>(null);
  const exportTriggerRef = useRef<HTMLButtonElement | null>(null);
  // The last import outcome the auto-close has seen (identity-tracked: the
  // builder-built io surface re-mints the outcome object every render).
  const seenOutcomeRef = useRef<CadImportOutcome | null>(null);

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
  const documentVolumeText =
    applied === null ? null : applied.state.measurement.volume.toFixed(3);

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

  // The honest scene fallback: an authoring action that REMOVES document
  // data (a feature deletion through the property panel, an undo) can
  // invalidate the active scene's request — the scene readers then return
  // null, and leaving the old pixels up would be fabrication. When the
  // active scene no longer resolves, the dispatch falls back to the
  // deepest scene the document still resolves (the create actions'
  // precedence: hole over revolve over extrude, then the plate). The
  // effect only ever FALLS BACK — a newly created deeper scene wins
  // through its action's own setActiveScene, never through this effect.
  const activeScene = engine.activeScene;
  const workbenchDocument = engine.documentApi.document;
  useEffect(() => {
    if (activeScene === "plate") return;
    const resolved =
      activeScene === "hole"
        ? documentHoleSceneRequest(workbenchDocument) !== null
        : activeScene === "revolve"
          ? documentRevolveRequest(workbenchDocument) !== null
          : documentExtrudeRequest(workbenchDocument) !== null;
    if (resolved) return;
    if (documentHoleSceneRequest(workbenchDocument) !== null) {
      engine.setActiveScene("hole");
    } else if (documentRevolveRequest(workbenchDocument) !== null) {
      engine.setActiveScene("revolve");
    } else if (documentExtrudeRequest(workbenchDocument) !== null) {
      engine.setActiveScene("extrude");
    } else {
      engine.setActiveScene("plate");
    }
  }, [activeScene, engine, workbenchDocument]);

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
        disabled: holeBase === undefined,
        group: "Workspace",
        id: "hole",
        keywords: "cut drill solid create",
        label: "Hole the last extrusion",
        run: handleHole,
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
          keywords: "stl 3mf step brep iges open upload",
          label: "Import model",
          run: () => {
            setImportDialogOpen(true);
          },
        },
      );
    }
    return list;
  }, [
    applied,
    clearSelection,
    handleHole,
    historyApi,
    holeBase,
    io,
    rollback,
    selectionApi.selected.length,
    setMode,
    setRollback,
    toolsApi,
  ]);

  // -- Default pieces (each exactly what its slot replaces) -----------------

  const defaultToolbar = <CadToolbar className="border-0 bg-transparent p-0" />;

  const defaultHistoryTimeline = (
    <div
      aria-label="Feature timeline"
      className="border-border flex h-full min-w-0 flex-1 items-center gap-1 border-l pl-3 [contain:inline-size]"
      data-testid="complete-feature-timeline"
      role="group"
    >
      <span className="text-muted-foreground/70 mr-1.5 shrink-0 font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
        Timeline
      </span>
      {timeline === null ? (
        <span className="text-muted-foreground shrink-0 text-xs">
          {regenerationIssue ?? "\u2026"}
        </span>
      ) : (
        <>
          {/* The chain scrolls HERE alone; the counter sits outside the
              scrolled content, so a long feature chain can never clip it
              mid-word (nor can the counter squeeze the chips). */}
          <div className="no-scrollbar flex h-full min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            <FeatureTimelineChips
              entries={timeline}
              rollback={rollback}
              onRollback={setRollback}
              onToggleSuppressed={toggleSuppressed}
            />
          </div>
          <FeatureTimelineSummary
            entries={timeline}
            executed={executed}
            rollback={rollback}
          />
        </>
      )}
    </div>
  );

  const defaultCommandMenu = (
    <>
      <Button
        data-testid="complete-command-menu-trigger"
        onClick={() => {
          setCommandMenuOpen(true);
        }}
        size="xs"
        title="Open the command menu (Ctrl+K)"
        type="button"
        variant="outline"
      >
        {LABELS.commandMenuTrigger}
        <kbd
          aria-hidden="true"
          className="border-current/40 border px-1 font-mono text-[10px] font-normal leading-4"
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

  const defaultViewport = (
    <div
      className="border-border/80 bg-background/50 relative shrink-0 rounded-lg border p-1 shadow-[inset_0_1px_0_color-mix(in_oklch,var(--foreground)_4%,transparent),0_1px_2px_color-mix(in_oklch,var(--foreground)_10%,transparent)]"
      data-viewport-showing={showingPreview ? "import" : "document"}
      id="workbench-complete-viewport"
    >
      <div className="relative overflow-hidden rounded-[6px]">
        <CadViewport
          className={VIEWPORT_CLASS}
          projection={
            showingPreview
              ? (ioSurface.preview?.projection ?? null)
              : applied === null
                ? null
                : applied.state.projection
          }
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
            // agrees with the settled volume, written synchronously.
            noteRenderedFrame(documentVolumeText);
          }}
          onSelectionRendered={(key) => {
            document
              .getElementById(rootId)
              ?.setAttribute("data-cad-selection-frame", key);
          }}
          overlay={
            showingPreview ? (
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
            ) : undefined
          }
        />
      </div>
    </div>
  );

  const defaultModelTree =
    regenerationStates === null ? null : (
      <CadModelTree regenerationStates={regenerationStates} className="w-48" />
    );

  const defaultPropertyPanel = (
    <CadPropertyPanel
      regenerationStates={regenerationStates ?? undefined}
      className="w-60 shrink-0"
    />
  );

  const defaultParameterPanel = <CadParameterPanel className="w-60 shrink-0" />;

  const defaultStatusBar = (
    <CadStatusBar
      surfaceIds={{
        statusId: "workbench-complete-status",
        volumeId: "workbench-complete-volume",
        errorId: "workbench-complete-error",
      }}
    />
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

  const toolbar = slots.toolbar?.(context) ?? defaultToolbar;
  const historyTimeline =
    slots.historyTimeline?.(context) ?? defaultHistoryTimeline;
  const commandMenu = slots.commandMenu?.(context) ?? defaultCommandMenu;
  const viewport = slots.viewport?.(context) ?? defaultViewport;
  const modelTree = slots.modelTree?.(context) ?? defaultModelTree;
  const propertyPanel = slots.propertyPanel?.(context) ?? defaultPropertyPanel;
  const parameterPanel =
    slots.parameterPanel?.(context) ?? defaultParameterPanel;
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
      id={rootId}
    >
      {/* The command row: tool strip, the scrolling timeline, then the
          pinned actions — history, the command menu trigger, and the
          file/mode actions in one shrink-0 group, so a long feature chain
          scrolls INSIDE the timeline and never pushes an action off the
          row. In sketch mode it yields to the sketch editor's own command
          row; the model surfaces stay MOUNTED but hidden so the session's
          surface writer keeps their ids. */}
      <div
        className={`border-border bg-card/50 h-10 shrink-0 items-center gap-2 border-b px-2 ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        {toolbar}
        {historyTimeline}
        <div className="flex shrink-0 items-center gap-2">
          <div
            aria-label="History"
            className="flex items-center gap-1"
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
                data-testid="complete-import"
                onClick={() => {
                  setImportDialogOpen(true);
                }}
                ref={importTriggerRef}
                size="xs"
                type="button"
                variant="outline"
              >
                {LABELS.import}
              </Button>
              <Button
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
                {LABELS.export}
              </Button>
            </>
          )}
          <Button
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
          <Button
            data-testid="complete-mode-toggle"
            onClick={() => {
              setMode("sketch");
            }}
            size="xs"
            type="button"
            variant="outline"
          >
            Sketch
          </Button>
        </div>
      </div>
      {mode === "sketch" ? (
        <SketchMode
          onExit={() => {
            setMode("model");
          }}
          onExtrude={handleExtrude}
          onRevolve={handleRevolve}
        />
      ) : null}
      {/* The workspace: tree dock left, viewport dominant, property +
          parameter docks right. Hidden (not unmounted) in sketch mode. */}
      <div
        className={`bg-background/30 min-h-0 flex-1 items-start gap-2 border-b p-2 ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        <div className="flex w-48 shrink-0 flex-col gap-2">
          {modelTree}
          <WorkbenchMeasurementSection
            boundsState={engine.boundsState}
            distanceSource={distanceSource}
            distanceText={distanceText}
            massPropertiesState={engine.massPropertiesState}
            radiusState={engine.radiusState}
          />
        </div>
        {viewport}
        <div className="flex min-h-0 w-60 shrink-0 flex-col gap-2 self-stretch">
          <div className="shrink-0">{propertyPanel}</div>
          <div className="min-h-0 flex-1 overflow-y-auto">{parameterPanel}</div>
        </div>
      </div>
      {statusBar}
      {ioDialogs}
    </div>
  );
}
