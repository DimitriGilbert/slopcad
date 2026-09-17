/**
 * The composed CAD workbench (Phase 15 phase-level deliverable, extended in
 * Phase 20): ONE browser page that mounts all four `@slopcad/ui` CAD
 * components — CadToolbar, CadViewport, CadModelTree, CadParameterPanel —
 * around a real document through a single `CadProvider` store, in a
 * product-grade tool layout: one dense command row across the top — the
 * tool strip, the feature timeline behind a divider, and the undo/redo
 * pair — with the model tree docked left, the parameter panel docked
 * right (internally scrollable when the document outgrows the frame),
 * the viewport dominant between them, and a status bar along the bottom.
 *
 * ## Composition wiring (page level only)
 *
 * The store is composed ONCE from the workbench's domain instances (the
 * workbench document — plate, bore diameter, translate + rotate features in
 * an upstream/downstream chain, expression-driven `volumeHint` — and the
 * tools that document supports: select, measure, rotate) and handed to
 * `CadProvider`. Every component mirrors its own concern below that
 * provider, so the components work TOGETHER while staying independent; the
 * page-level effects follow the document (the worker computation follows
 * the hole parameter), push the current projection into the store, and
 * announce each applied revision as a new regeneration.
 *
 * ## The Phase 20 regeneration loop (page level)
 *
 * The page threads regeneration state ACROSS edits — the robust loop, not a
 * from-scratch derivation: on every document / suppression / rollback
 * change it diffs the previous document into changed graph nodes
 * (`documentChangeInvalidations`), marks exactly those stale
 * (`markStale`), and runs one `regenerate` pass with the executor
 * stand-in, the suppressed set, the rollback marker, and the PRIOR
 * executor-results registry. Upstream edits therefore re-run only the
 * affected downstream chain, a failing feature leaves its already-executed
 * upstream valid (with last-known-valid results retained), and the same
 * change applied twice produces the identical executed sequence.
 *
 * ## The feature timeline strip
 *
 * The timeline is the history surface no component owns (the same reason
 * the undo/redo pair lives here, and the reason both share the command
 * row): one chip per feature in document order,
 * joined five-way status per chip (`valid`/`stale`/`failed`/`suppressed`/
 * `beyond-rollback` — suppression wins over parking), the rollback marker
 * as a clickable element BETWEEN chips (click a gap to roll back after the
 * feature before it, or before the first; click the marker to remove it and
 * re-execute what was parked), and a suppress toggle per chip (dependents
 * re-run without the suppressed feature, per the Phase 6.3 rule).
 *
 * ## Machine-readable surface (`#workbench-root`)
 *
 * The settle attributes the worker session writes (`data-in-flight`,
 * `data-applied-revision`, `data-current-revision`, `data-volume`,
 * `data-error`), the viewport's settle stamps (`data-cad-rendered-volume`
 * from `onSettled`, `data-cad-selection-frame` from `onSelectionRendered`),
 * the mirrored domain state (`data-selection`, `data-selection-key`,
 * `data-tool-id`, `data-tool-phase`, `data-tool-state`,
 * `data-tool-completion`, `data-tool-failure`, `data-measure`),
 * `data-command-log` (the store's canonical serialized transactions),
 * `data-hole-diameter` (the document's stored parameter), `data-history`
 * (the undo/redo view), `data-feature-timeline` (the Phase 20 view: rollback
 * marker, per-feature joined statuses, the last run's executed sequence),
 * and `data-rendered-frames`, plus `data-face-anchors` on
 * `#workbench-viewport` (the deterministic click targets, relative to the
 * viewport's 800×520 CSS box — the size the fixture camera spec is authored
 * for).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  CadProvider,
  createCadStore,
  documentChangeInvalidations,
  type CadDocument,
  type FeatureId,
  featureTimeline,
  type FeatureRollbackPoint,
  type FeatureTimelineEntry,
  type FeatureTimelineStatus,
  initialRegenerationStates,
  markStale,
  measureTool,
  type RegenerationResultMap,
  type RegenerationStateMap,
  regenerate,
  registerTool,
  rotateTool,
  selectTool,
  SELECT_TOOL_ID,
  selectionReferenceKey,
  serializeSelectionReference,
  useCadDocument,
  useCadHistory,
  useCadSelection,
  useCadStore,
  useCadTools,
  valueIn,
} from "@slopcad/cad-react";
import { Eye, EyeOff, Redo2, Undo2 } from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
import { CadModelTree } from "@slopcad/ui/components/cad/cad-model-tree";
import { CadParameterPanel } from "@slopcad/ui/components/cad/cad-parameter-panel";
import { CadToolbar } from "@slopcad/ui/components/cad/cad-toolbar";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import {
  bootRenderFixtureSession,
  completionJson,
  faceAnchorSurface,
  type RenderFixtureSession,
} from "../render-fixture/fixture-session";
import { holeDiameterMm } from "../workbench-fixture/workbench-document";
import { workbenchExecutor } from "../workbench-fixture/workbench-extended-document";
import { createCadWorkbenchSession } from "./session";
import { SketchMode } from "./SketchMode";

/** An applied computation: the render state plus its revision identity. */
interface AppliedRenderState {
  readonly state: PlateRenderState;
  readonly revision: number;
}

/** The threaded regeneration state the page carries between edits. */
interface WorkbenchRunState {
  readonly states: RegenerationStateMap;
  readonly results: RegenerationResultMap;
  readonly executed: readonly FeatureId[];
}

/** The previous inputs the derivation effect diffs against. */
interface DerivationPrevious {
  readonly document: CadDocument;
  readonly suppressedKey: string;
  readonly rollbackKey: string;
  readonly states: RegenerationStateMap;
  readonly results: RegenerationResultMap;
}

/** Visual presentation of one joined timeline status. */
const TIMELINE_STATUS_PRESENTATION: Readonly<
  Record<
    FeatureTimelineStatus,
    { readonly dot: string; readonly text: string; readonly chip: string }
  >
> = Object.freeze({
  // The healthy state stays quiet; failures are the only loud chip.
  valid: Object.freeze({
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    chip: "border-border",
  }),
  stale: Object.freeze({
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    chip: "border-border",
  }),
  failed: Object.freeze({
    dot: "bg-destructive",
    text: "text-destructive font-medium",
    chip: "border-destructive/60",
  }),
  suppressed: Object.freeze({
    dot: "border border-muted-foreground/60 bg-transparent",
    text: "text-muted-foreground italic",
    chip: "border-dashed border-border",
  }),
  "beyond-rollback": Object.freeze({
    dot: "bg-sky-500",
    text: "text-sky-600 dark:text-sky-400",
    chip: "border-dashed border-sky-500/60",
  }),
});

/** The joined-status labels the timeline chip renders. */
const TIMELINE_STATUS_LABELS: Readonly<
  Record<FeatureTimelineStatus, string>
> = Object.freeze({
  valid: "Valid",
  stale: "Stale",
  failed: "Failed",
  suppressed: "Suppressed",
  "beyond-rollback": "Parked",
});

/** The workbench's top-level modes: the 3D model workspace or the sketch. */
type WorkbenchMode = "model" | "sketch";

export function CadWorkbenchPage(): ReactElement {
  // The workbench mode is page-level authoring state: the model workspace
  // keeps its worker session alive across switches (hidden, not unmounted).
  const [mode, setMode] = useState<WorkbenchMode>("model");

  // The store is composed ONCE from the workbench's domain instances; the
  // provider hands it to the hooks and to every CAD component below.
  const [store] = useState(() =>
    createCadStore({
      session: createCadWorkbenchSession(),
      tools: [
        registerTool(selectTool),
        registerTool(measureTool),
        registerTool(rotateTool),
      ],
    }),
  );

  return (
    <CadProvider store={store}>
      <CadWorkbenchBody
        mode={mode}
        onModeChange={setMode}
      />
    </CadProvider>
  );
}

function CadWorkbenchBody({
  mode,
  onModeChange,
}: {
  readonly mode: WorkbenchMode;
  readonly onModeChange: (mode: WorkbenchMode) => void;
}): ReactElement {
  const store = useCadStore("CadWorkbenchPage");
  const documentApi = useCadDocument();
  const selectionApi = useCadSelection();
  const toolsApi = useCadTools();
  const historyApi = useCadHistory();
  const { arm } = toolsApi;
  const { beginRegeneration } = selectionApi;

  const [applied, setApplied] = useState<AppliedRenderState | null>(null);
  const [renderedFrames, setRenderedFrames] = useState(0);
  const sessionRef = useRef<RenderFixtureSession | null>(null);

  // The executor stand-in: the document's hole parameter is the source of
  // truth; the worker computation follows it (the same pipeline as the
  // /render and Phase 14 fixtures).
  const storedHole = holeDiameterMm(documentApi.document);

  // -- The Phase 20 threaded regeneration loop ------------------------------
  // Page-level authoring state: the suppressed set and the rollback marker
  // are authoring data (not document data), so they live here and ride into
  // every regenerate pass.
  const [suppressed, setSuppressed] = useState<ReadonlySet<FeatureId>>(
    () => new Set(),
  );
  const [rollback, setRollback] = useState<FeatureRollbackPoint | null>(null);
  const [runState, setRunState] = useState<WorkbenchRunState | null>(null);
  const [regenerationIssue, setRegenerationIssue] = useState<string | null>(
    null,
  );
  const previousRef = useRef<DerivationPrevious | null>(null);

  const workbenchDocument = documentApi.document;
  const suppressedKey = useMemo(
    () =>
      [...suppressed]
        .map((id) => String(id))
        .sort()
        .join(","),
    [suppressed],
  );
  const rollbackKey =
    rollback === null ? "" : `after:${String(rollback.afterFeatureId)}`;

  useEffect(() => {
    const previous = previousRef.current;
    if (
      previous !== null &&
      previous.document === workbenchDocument &&
      previous.suppressedKey === suppressedKey &&
      previous.rollbackKey === rollbackKey
    ) {
      return;
    }
    const features = workbenchDocument.features;
    const changedNodes =
      previous === null || previous.document === workbenchDocument
        ? []
        : documentChangeInvalidations(previous.document, workbenchDocument);
    const states =
      previous === null
        ? initialRegenerationStates(features)
        : markStale(features, previous.states, changedNodes);
    const applied = regenerate({
      features,
      states,
      suppressed: [...suppressed],
      execute: workbenchExecutor(workbenchDocument),
      rollbackPoint: rollback,
      results: previous?.results,
    });
    if (!applied.ok) {
      setRegenerationIssue(applied.error.message);
      return;
    }
    setRegenerationIssue(null);
    setRunState({
      states: applied.value.states,
      results: applied.value.results,
      executed: applied.value.executed,
    });
    previousRef.current = {
      document: workbenchDocument,
      suppressedKey,
      rollbackKey,
      states: applied.value.states,
      results: applied.value.results,
    };
  }, [workbenchDocument, suppressed, suppressedKey, rollback, rollbackKey]);

  const timeline: readonly FeatureTimelineEntry[] | null = useMemo(() => {
    if (runState === null) return null;
    const joined = featureTimeline({
      features: workbenchDocument.features,
      states: runState.states,
      rollback,
      suppressed: [...suppressed],
    });
    return joined.ok ? joined.value : null;
  }, [workbenchDocument, runState, rollback, suppressed]);

  const toggleSuppressed = (id: FeatureId): void => {
    setSuppressed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // The tree's statuses: the threaded loop's durable state map (statuses are
  // PROP-ONLY; parked features read stale — their durable state).
  const regenerationStates = runState === null ? null : runState.states;

  useEffect(() => {
    // The host's explicit boot configuration: the SELECT tool armed through
    // the hook layer (cancel-if-active, reset, activate).
    arm(SELECT_TOOL_ID);
    const session = bootRenderFixtureSession(
      {
        rootId: "workbench-root",
        statusId: "workbench-status",
        volumeId: "workbench-volume",
        errorId: "workbench-error",
      },
      (state, revision) => {
        setApplied({ state, revision });
        // A NEW regeneration: synthetic references die with the old one;
        // stable references persist.
        beginRegeneration(revision);
      },
    );
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
    // arm and beginRegeneration are stable store operation identities: the
    // session boots exactly once.
  }, [arm, beginRegeneration]);

  useEffect(() => {
    if (storedHole === null) return;
    sessionRef.current?.dispatch(storedHole);
  }, [storedHole]);

  // The host pushes the CURRENT projection into the store — the projection
  // access the active tool reads. Host-side state push, not mirrored state.
  useEffect(() => {
    store.setProjection(applied === null ? null : applied.state.projection);
  }, [applied, store]);

  const selectionKey = useMemo(
    () => selectionApi.selected.map(selectionReferenceKey).join(";"),
    [selectionApi.selected],
  );

  const faceAnchors = useMemo(
    () => (applied === null ? "" : faceAnchorSurface(applied.state)),
    [applied],
  );

  // The measure tool's completion: the readout the Measurement block shows.
  const measureText =
    toolsApi.completion !== null &&
    toolsApi.completion.detail.kind === "measurement"
      ? valueIn(toolsApi.completion.detail.distance, "mm").toFixed(3)
      : null;

  const timelineJson = useMemo(
    () =>
      JSON.stringify({
        rollback:
          rollback === null
            ? null
            : { afterFeatureId: rollback.afterFeatureId },
        entries: timeline ?? [],
        executed: runState === null ? [] : runState.executed,
      }),
    [rollback, timeline, runState],
  );

  return (
    <div
      id="workbench-root"
      className="flex h-full min-h-0 flex-col"
      data-selection={JSON.stringify(
        selectionApi.selected.map(serializeSelectionReference),
      )}
      data-selection-key={selectionKey}
      data-selection-regeneration={String(selectionApi.regeneration)}
      data-tool-id={toolsApi.activeToolId ?? ""}
      data-tool-phase={toolsApi.phase}
      data-tool-state={JSON.stringify(toolsApi.toolState)}
      data-tool-completion={
        toolsApi.completion === null ? "" : completionJson(toolsApi.completion)
      }
      data-tool-failure={
        toolsApi.failure === null ? "" : JSON.stringify(toolsApi.failure)
      }
      data-measure={measureText === null ? "" : `${measureText} mm`}
      data-command-log={JSON.stringify(store.commandLog)}
      data-rendered-frames={String(renderedFrames)}
      data-hole-diameter={storedHole === null ? "" : String(storedHole)}
      data-history={JSON.stringify({
        canUndo: historyApi.canUndo,
        canRedo: historyApi.canRedo,
        cursor: historyApi.cursor,
        depth: historyApi.depth,
      })}
      data-feature-timeline={timelineJson}
      data-sketch-mode={mode}
    >
      {/* Tool row: the component's tool strip; the feature timeline (the
          Phase 20 history surface) sits beside it behind a divider, and the
          undo/redo pair on the right — the page-level surfaces of concerns
          no component owns. One dense row keeps the docked palettes inside
          the workbench frame at the fixture's fixed viewport. In sketch
          mode the row (and the whole model workspace) yields to the sketch
          editor, which carries its own command row; the model surfaces stay
          MOUNTED but hidden so the worker session's surface writer keeps
          their ids. */}
      <div
        className={`border-border bg-background h-10 shrink-0 items-center gap-2 border-b px-2 ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        {/* Provider-driven toolbar: no props — it mirrors the registry,
            presses the live tool, and arms through the store's arm op. The
            row it sits in carries the divider, so the strip drops its own
            box. */}
        <CadToolbar className="border-0 bg-transparent p-0" />
        <div
          aria-label="Feature timeline"
          className="border-border flex h-full min-w-0 items-center gap-1 border-l pl-3"
          data-testid="feature-timeline"
          role="group"
        >
          <span className="text-muted-foreground mr-1 text-xs font-medium tracking-wider uppercase">
            Timeline
          </span>
          {timeline === null ? (
            <span className="text-muted-foreground text-xs">
              {regenerationIssue ?? "\u2026"}
            </span>
          ) : (
            <FeatureTimelineStrip
              entries={timeline}
              rollback={rollback}
              executed={runState === null ? [] : runState.executed}
              onRollback={setRollback}
              onToggleSuppressed={toggleSuppressed}
            />
          )}
        </div>
        <div className="flex-1" />
        <div aria-label="History" className="flex items-center gap-1" role="group">
          <Button
            id="history-undo"
            type="button"
            variant="ghost"
            size="xs"
            disabled={!historyApi.canUndo}
            onClick={() => {
              historyApi.undo();
            }}
          >
            <Undo2 data-icon="inline-start" />
            Undo
          </Button>
          <Button
            id="history-redo"
            type="button"
            variant="ghost"
            size="xs"
            disabled={!historyApi.canRedo}
            onClick={() => {
              historyApi.redo();
            }}
          >
            <Redo2 data-icon="inline-start" />
            Redo
          </Button>
        </div>
        <Button
          data-testid="workbench-mode-toggle"
          onClick={() => {
            onModeChange("sketch");
          }}
          size="xs"
          type="button"
          variant="outline"
        >
          Sketch
        </Button>
      </div>
      {mode === "sketch" ? <SketchMode onExit={() => { onModeChange("model"); }} /> : null}
      {/* The workspace: tree palette left, viewport dominant, parameter
          palette right — the components' own sizes are the layout's sizes.
          The row is centered as a group so the leftover workspace frames
          the composition symmetrically instead of pooling below it. Hidden
          (not unmounted) in sketch mode: the model keeps living. */}
      <div
        className={`min-h-0 flex-1 items-center justify-center p-3 ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        <div className="flex max-h-full min-h-0 items-start gap-3">
          <div className="flex w-48 shrink-0 flex-col gap-3">
            {/* Provider-driven tree with one explicit prop: the regeneration
                states. Document, selection, and picks all mirror the store. */}
            {regenerationStates === null ? null : (
              <CadModelTree
                regenerationStates={regenerationStates}
                className="w-48"
              />
            )}
            <section
              aria-label="Measurement"
              className="border-border bg-background w-48 border"
            >
              <div className="text-muted-foreground border-border border-b px-2 py-1.5 text-xs font-medium tracking-wider uppercase">
                Measurement
              </div>
              <div className="px-2 py-2 text-sm">
                {measureText === null ? (
                  <span className="text-muted-foreground font-mono">—</span>
                ) : (
                  <span id="workbench-measure-readout" className="font-mono">
                    {`${measureText} mm`}
                  </span>
                )}
              </div>
            </section>
          </div>
          {/* Fixed pixel box: part of the determinism contract (the camera
              spec is authored for exactly this 800×520 viewport; the scene
              runs at dpr 1). Provider-driven viewport: no selection props,
              no pick callbacks — picks, hovers, and keyboard are the
              component's own wiring. No overlay: the status bar carries the
              state the fixture chips used to. */}
          <div
            id="workbench-viewport"
            className="shrink-0"
            data-face-anchors={faceAnchors}
          >
            <CadViewport
              className="h-[520px] w-[800px]"
              projection={applied === null ? null : applied.state.projection}
              onSettled={() => {
                // Settle protocol: pixels may be compared only once this
                // stamp agrees with the settled volume.
                document
                  .getElementById("workbench-root")
                  ?.setAttribute(
                    "data-cad-rendered-volume",
                    applied === null
                      ? ""
                      : applied.state.measurement.volume.toFixed(3),
                  );
                setRenderedFrames((frames) => frames + 1);
              }}
              onSelectionRendered={(key) => {
                document
                  .getElementById("workbench-root")
                  ?.setAttribute("data-cad-selection-frame", key);
              }}
            />
          </div>
          {/* Provider-driven parameter panel: no props — it mirrors the
              document's parameters, validates expressions with the domain's
              own parser/evaluator, and applies edits as parameter.set
              transactions through the store. */}
          {/* The parameter dock scrolls internally when the document
              carries more parameters than the frame shows at once — a
              docked palette never pushes the status bar around. */}
          <div className="flex min-h-0 flex-1 flex-col self-stretch overflow-y-auto">
            <CadParameterPanel className="w-60 shrink-0" />
          </div>
        </div>
      </div>
      {/* Status bar: the settled numbers the operator works against. The
          status and volume spans are written by the worker session's
          surface writer (the fixture pattern); the rest mirror the store.
          Hidden in sketch mode — the sketch editor carries its own status
          line — but MOUNTED, so the writer's ids keep existing. */}
      <div
        className={`border-border bg-background text-muted-foreground h-7 shrink-0 items-center gap-4 border-t px-3 font-mono text-xs ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        <span>
          status ={" "}
          <span id="workbench-status" data-testid="workbench-status">
            boot
          </span>
        </span>
        <span>
          volume = <span id="workbench-volume">…</span>
          {"\u00A0"}mm³
        </span>
        <span>
          tool = {toolsApi.activeToolId ?? "none"} ({toolsApi.phase})
        </span>
        <span>selection = {selectionApi.selected.length}</span>
        <span>commands = {store.commandLog.length}</span>
        <span data-testid="workbench-error" className="text-destructive">
          <span id="workbench-error" />
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The timeline strip
// ---------------------------------------------------------------------------

interface FeatureTimelineStripProps {
  readonly entries: readonly FeatureTimelineEntry[];
  readonly rollback: FeatureRollbackPoint | null;
  readonly executed: readonly FeatureId[];
  readonly onRollback: (rollback: FeatureRollbackPoint | null) => void;
  readonly onToggleSuppressed: (id: FeatureId) => void;
}

/**
 * The chips and gaps of the feature timeline: one gap before each chip and
 * one after the last, each a named rollback target; the gap the marker
 * currently occupies renders the marker and clears it when clicked. The
 * right-aligned summary names the marker's position and the last run's
 * executed/parked counts.
 */
function FeatureTimelineStrip({
  entries,
  rollback,
  executed,
  onRollback,
  onToggleSuppressed,
}: FeatureTimelineStripProps): ReactElement {
  const parkedCount = entries.filter(
    (entry) => entry.status === "beyond-rollback",
  ).length;
  const activeIndex =
    rollback === null
      ? null
      : rollback.afterFeatureId === null
        ? 0
        : entries.findIndex((entry) => entry.id === rollback.afterFeatureId) + 1;
  const lastEntry = entries[entries.length - 1];
  return (
    <>
      {entries.map((entry, index) => {
        const before = entries[index - 1];
        return (
          <TimelineFragment
            key={entry.id}
            entry={entry}
            gapAnchorId={before?.id ?? null}
            gapLabel={
              before === undefined
                ? `Roll back before ${entry.kind}`
                : `Roll back after ${before.kind}`
            }
            activeGap={activeIndex === index}
            onSetRollback={(anchorId) => {
              onRollback({ afterFeatureId: anchorId });
            }}
            onClearRollback={() => {
              onRollback(null);
            }}
            onToggleSuppressed={onToggleSuppressed}
          />
        );
      })}
      <TimelineGap
        label={`Roll back after ${lastEntry?.kind ?? ""}`}
        active={activeIndex !== null && activeIndex >= entries.length}
        onSet={() => {
          if (lastEntry !== undefined) {
            onRollback({ afterFeatureId: lastEntry.id });
          }
        }}
        onClear={() => {
          onRollback(null);
        }}
      />
      <span
        className="text-muted-foreground ml-auto shrink-0 pl-3 font-mono text-[11px]"
        data-testid="timeline-summary"
      >
        {rollback === null ? "" : "rollback · "}
        {` ${String(executed.length)} executed`}
        {parkedCount > 0 ? ` · ${String(parkedCount)} parked` : ""}
      </span>
    </>
  );
}

interface TimelineFragmentProps {
  readonly entry: FeatureTimelineEntry;
  /** The feature id the gap before this chip sits after (`null` = start). */
  readonly gapAnchorId: FeatureId | null;
  readonly gapLabel: string;
  readonly activeGap: boolean;
  readonly onSetRollback: (anchorId: FeatureId | null) => void;
  readonly onClearRollback: () => void;
  readonly onToggleSuppressed: (id: FeatureId) => void;
}

/** One chip plus the rollback gap before it. */
function TimelineFragment({
  entry,
  gapAnchorId,
  gapLabel,
  activeGap,
  onSetRollback,
  onClearRollback,
  onToggleSuppressed,
}: TimelineFragmentProps): ReactElement {
  const presentation = TIMELINE_STATUS_PRESENTATION[entry.status];
  const suppressed = entry.status === "suppressed";
  return (
    <>
      <TimelineGap
        label={gapLabel}
        active={activeGap}
        onSet={() => {
          onSetRollback(gapAnchorId);
        }}
        onClear={onClearRollback}
      />
      <span
        className={`flex shrink-0 items-center gap-1.5 border px-2 py-1 text-xs ${presentation.chip}`}
        data-testid="timeline-chip"
        data-timeline-id={entry.id}
        data-timeline-status={entry.status}
        title={
          entry.diagnostics.length === 0
            ? `${entry.kind} (${String(entry.id)})`
            : entry.diagnostics
                .map((diagnostic) => diagnostic.message)
                .join("\n")
        }
      >
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${presentation.dot}`}
        />
        <span className={presentation.text}>{entry.kind}</span>
        <span className={`text-[11px] leading-none ${presentation.text}`}>
          {TIMELINE_STATUS_LABELS[entry.status]}
        </span>
        <button
          type="button"
          aria-label={suppressed ? `Include ${entry.kind}` : `Suppress ${entry.kind}`}
          aria-pressed={suppressed}
          className="text-muted-foreground hover:text-foreground ml-0.5 inline-flex size-4 cursor-pointer items-center justify-center"
          title={suppressed ? `Include ${entry.kind}` : `Suppress ${entry.kind}`}
          onClick={() => {
            onToggleSuppressed(entry.id);
          }}
        >
          {suppressed ? (
            <Eye aria-hidden="true" className="size-3" />
          ) : (
            <EyeOff aria-hidden="true" className="size-3" />
          )}
        </button>
      </span>
    </>
  );
}

/**
 * The rollback gap between two chips (or before the first / after the
 * last): a narrow named button. When the marker occupies this gap, the gap
 * renders the amber marker bar and clicking removes it.
 */
function TimelineGap({
  label,
  active,
  onSet,
  onClear,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onSet: () => void;
  readonly onClear: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={active ? `Remove rollback point — ${label}` : label}
      className="hover:bg-muted relative h-5 w-3 shrink-0 cursor-pointer"
      title={active ? `Remove rollback point — ${label}` : label}
      onClick={() => {
        if (active) {
          onClear();
        } else {
          onSet();
        }
      }}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="bg-amber-500 absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2"
          data-testid="rollback-marker"
        />
      ) : null}
    </button>
  );
}
