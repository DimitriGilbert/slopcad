/**
 * The Phase 26 phase-level deliverable: the cross-feature chain workbench —
 * ONE continuous browser session that sketches a rectangle, extrudes it,
 * cuts a hole, fillets a picked edge, edits an upstream parameter, and
 * watches the regeneration cascade — with the failure propagation and the
 * feature history the plan pins.
 *
 * ## Composition (the workbench discipline, one kernel up)
 *
 * The page composes the SAME provider-driven components as the Phase 15
 * workbench — CadToolbar, CadViewport, CadModelTree, CadParameterPanel
 * around one `CadProvider` store, the feature timeline and the undo/redo
 * pair in the command row, the sketch mode as the authoring entry — over a
 * document that starts EMPTY and accumulates the chain. The one deliberate
 * difference is the session: the chain boots the OCCT worker (the
 * /worker-fillet precedent's entry), because the chain needs a fillet and
 * mixed-kernel-per-feature is not a capability — one session, one worker,
 * one kernel. Every solid stage (extrude, hole, fillet) therefore executes
 * on OpenCascade through the chain scene (see
 * `../worker-fixture/chain-scene`), and the kernel's exact volumes are the
 * semantic surface.
 *
 * ## The regeneration loop (worker verdicts feed the domain)
 *
 * The page threads the Phase 20 regeneration state ACROSS edits exactly
 * like the workbench: document diffs → `markStale` → one `regenerate` pass
 * with the executor, the suppressed set, the rollback marker, and the
 * prior results registry. The executor seam is fed by the WORKER: a
 * settled dispatch clears every recorded verdict (everything present
 * executed), a failed dispatch records ONE stage-attributed failure
 * (`ChainStageFailure` — feature id, kernel code, message). A verdict
 * change invalidates exactly the judged features (`verdictInvalidations`
 * below): the judged feature re-runs through the domain pass, and the
 * executor answers with the worker's verdict — the feature FAILS with the
 * structured diagnostics while its upstream keeps the valid states it
 * already earned (last-known-valid), and the failed dispatch never became
 * visible, so the last-known-valid SCENE stays up too. Fixing the
 * parameter re-dispatches; the settle clears the verdict; the judged
 * feature re-runs green and the cascade follows.
 *
 * ## The fillet pick (the snapshot-address design)
 *
 * The chain scene returns the fillet TARGET's topology snapshot at every
 * settle; the page projects its edge centroids through the scene camera
 * and publishes them as `data-edge-anchors`. A click on the viewport
 * selects the nearest anchor within {@link CHAIN_EDGE_PICK_RADIUS_PX} —
 * the pick IS a snapshot ordinal, the address `solid.fillet` consumes (the
 * /worker-fillet precedent; the ordinal rides the document as a
 * dimensionless parameter — see `./chain` for the disclosed decision).
 *
 * ## Machine surface (`#chain-root`)
 *
 * The session's settle surface (`data-in-flight`, `data-applied-revision`,
 * `data-current-revision`, `data-volume`, `data-volume-exact`,
 * `data-error`), the mirrored domain state (selection, tool, command log,
 * `data-history`, `data-feature-timeline`), the chain surfaces
 * (`data-chain-stage`: empty → extrude → hole → fillet from the document;
 * `data-stage-volumes`: every stage's full-precision measurement from the
 * applied scene; `data-edge-anchors`; `data-selected-edge`;
 * `data-chain-failure`: the structured stage failure JSON), the scene
 * extents/bounds, and `data-rendered-frames`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  CadProvider,
  createCadStore,
  documentChangeInvalidations,
  type CadDocument,
  type CadSession,
  DIAGNOSTIC_CODES,
  type FeatureExecutionOutcome,
  type FeatureId,
  type FeatureRecord,
  type FeatureRollbackPoint,
  featureTimeline,
  type FeatureTimelineEntry,
  initialRegenerationStates,
  markStale,
  measureTool,
  type RegenerationResultMap,
  type RegenerationStateMap,
  registerTool,
  regenerate,
  selectTool,
  SELECT_TOOL_ID,
  selectionReferenceKey,
  serializeSelectionReference,
  createDocument,
  createDocumentId,
  createSession,
  useCadDocument,
  useCadHistory,
  useCadSelection,
  useCadStore,
  useCadTools,
  valueIn,
} from "@slopcad/cad-react";
import {
  createBodyId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  formatBoundsExtents,
  length,
} from "@slopcad/cad-core";
import { Redo2, Undo2 } from "lucide-react";
import { renderCameraScreenPoint } from "@slopcad/cad-r3f";
import { Button } from "@slopcad/ui/components/button";
import { CadModelTree } from "@slopcad/ui/components/cad/cad-model-tree";
import { CadParameterPanel } from "@slopcad/ui/components/cad/cad-parameter-panel";
import { CadToolbar } from "@slopcad/ui/components/cad/cad-toolbar";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import type { ChainScene } from "../worker-fixture/chain-scene";
import type { ChainStageFailure } from "../worker-fixture/chain-scene";

import {
  completionJson,
  faceAnchorSurface,
} from "../render-fixture/fixture-session";
import { extrudeCamera } from "../render-fixture/plate-render-scene";
import {
  bootChainFixtureSession,
  renderedMeasurementOf,
  type AppliedChainScene,
  type ChainFixtureSession,
} from "../render-fixture/chain-fixture-session";
import { extrudeSceneRequestOfFeature } from "./extrude";
import {
  defaultHolePosition,
  holeBaseFeatureOf,
  holeCutInputOfFeature,
  HOLE_DEFAULT_AXIS,
  HOLE_DEFAULT_DEPTH_MM,
  HOLE_DEFAULT_DIAMETER_MM,
} from "./hole";
import {
  chainFilletInputOf,
  CHAIN_FILLET_DEFAULT_RADIUS_MM,
  documentChainSceneRequest,
  filletBaseFeatureOf,
  nextExtrudeInvalidatesChain,
  nextHoleInvalidatesChain,
} from "./chain";
import {
  EXTRUDE_DEFAULT_DEPTH_MM,
  SketchMode,
  type SketchExtrudeSubmission,
} from "./SketchMode";
import { clampedRollbackMarker, rollbackMarkerKey } from "./rollback-marker";
import { FeatureTimelineStrip } from "./feature-timeline-strip";

/** The chain page's root id — the settle surface's host. */
const CHAIN_ROOT_ID = "chain-root";

/** The fixture camera's frame (the viewport's fixed CSS box). */
const VIEWPORT_CSS_WIDTH = 800;
const VIEWPORT_CSS_HEIGHT = 520;

/** Maximum distance (CSS px) a click may land from an anchor to pick it. */
export const CHAIN_EDGE_PICK_RADIUS_PX = 24;

/**
 * The page's threaded regeneration state (the workbench's shape): the
 * durable state map, the results registry, and the last run's sequence.
 */
interface ChainRunState {
  readonly states: RegenerationStateMap;
  readonly results: RegenerationResultMap;
  readonly executed: readonly FeatureId[];
}

/** The previous inputs the derivation effect diffs against. */
interface DerivationPrevious {
  readonly document: CadDocument;
  readonly suppressedKey: string;
  readonly rollbackKey: string;
  readonly outcomes: WorkerOutcomes;
  readonly states: RegenerationStateMap;
  readonly results: RegenerationResultMap;
}

/** The worker's recorded verdict per feature (empty after every settle). */
type WorkerOutcomes = ReadonlyMap<FeatureId, FeatureExecutionOutcome>;

/** The chain document's stages, as the machine surface names them. */
type ChainStageName = "empty" | "extrude" | "hole" | "fillet";

/**
 * The chain workbench's document: an EMPTY deterministic document — the
 * workflow builds every feature through the page's actions, so the
 * timeline, the cascade, and the history are all authored in the session.
 */
function createCadChainSession(): CadSession {
  return createSession(createDocument(createDocumentId("doc_cad_chain")));
}

/**
 * The structural executor verdict: whether the feature's own inputs still
 * resolve (the optimistic pre-dispatch stance — the worker's recorded
 * verdict, when one exists, is the authority layered on top).
 */
function structuralOutcome(
  document: CadDocument,
  feature: FeatureRecord,
): FeatureExecutionOutcome {
  const unresolvable = (what: string): FeatureExecutionOutcome => ({
    ok: false,
    diagnostics: [
      {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelFeatureInputInvalid,
        message: `The ${feature.kind} feature "${feature.id}" no longer resolves: ${what}`,
        location: { primary: feature.id },
      },
    ],
  });
  if (feature.kind === "extrude") {
    return extrudeSceneRequestOfFeature(document, feature) !== null
      ? { ok: true }
      : unresolvable("the sketch or the distance parameter is gone");
  }
  if (feature.kind === "hole") {
    return holeCutInputOfFeature(document, feature) !== null
      ? { ok: true }
      : unresolvable("the target or one of the five hole parameters is gone");
  }
  if (feature.kind === "fillet") {
    return chainFilletInputOf(document, feature) !== null
      ? { ok: true }
      : unresolvable("the target, the radius, or the edge ordinal is gone");
  }
  return unresolvable("the chain workbench does not execute this kind");
}

/** The document's chain stage: the newest solid feature kind present. */
function chainStageOf(document: CadDocument): ChainStageName {
  const kinds = document.features.map((feature) => feature.kind);
  if (kinds.includes("fillet")) return "fillet";
  if (kinds.includes("hole")) return "hole";
  if (kinds.includes("extrude")) return "extrude";
  return "empty";
}

/**
 * The verdict invalidations: the features whose recorded worker verdict
 * appeared, disappeared, or changed between two verdict maps. A failure
 * makes its feature due again (so the domain pass can carry the verdict);
 * a settle empties the map, which makes the cleared features due again
 * (so the domain pass can re-earn green). Everything else keeps the state
 * it already earned.
 */
function verdictInvalidations(
  previous: WorkerOutcomes,
  next: WorkerOutcomes,
): readonly FeatureId[] {
  const changed = new Set<FeatureId>();
  for (const [id, verdict] of previous) {
    const recorded = next.get(id);
    if (recorded === undefined || recorded.ok !== verdict.ok) changed.add(id);
  }
  for (const id of next.keys()) {
    if (!previous.has(id)) changed.add(id);
  }
  return [...changed];
}

/**
 * One pickable edge of the target snapshot: the CSS-pixel anchor point and
 * the kernel-measured centroid + length (the fillet fixture's anchor form,
 * fed by the chain scene's snapshot).
 */
export interface ChainEdgeAnchor {
  readonly point: readonly [number, number];
  readonly lengthMm: number;
  readonly centroidMm: readonly [number, number, number];
}

/**
 * The projected edge anchors of the applied chain scene: per snapshot edge
 * ordinal, the CSS-pixel anchor and the kernel measures — a pure function
 * of the applied scene, deterministic, so the spec derives every pick from
 * the surface (the house rule: no guessed pixels).
 */
export function chainEdgeAnchorSurface(scene: ChainScene): string {
  const camera = extrudeCamera(renderedMeasurementOf(scene).bounds);
  const anchors: Record<string, ChainEdgeAnchor> = {};
  for (const entity of scene.snapshot.entities) {
    if (entity.kind !== "edge") continue;
    const centroid = entity.geometry.centroidAbsoluteMm;
    const lengthMm = entity.geometry.lengthMm;
    if (centroid === undefined || lengthMm === undefined) continue;
    const screen = renderCameraScreenPoint(
      camera,
      centroid,
      VIEWPORT_CSS_WIDTH,
      VIEWPORT_CSS_HEIGHT,
    );
    anchors[String(entity.ordinal)] = {
      point: [Number(screen[0].toFixed(1)), Number(screen[1].toFixed(1))],
      lengthMm: Number(lengthMm.toFixed(3)),
      centroidMm: [centroid[0], centroid[1], centroid[2]],
    };
  }
  return JSON.stringify(anchors);
}

export function CadChainWorkbenchPage(): ReactElement {
  // The page-level authoring mode: the model workspace keeps its OCCT
  // worker session alive across switches (hidden, not unmounted).
  const [mode, setMode] = useState<"model" | "sketch">("model");

  const [store] = useState(() =>
    createCadStore({
      session: createCadChainSession(),
      tools: [registerTool(selectTool), registerTool(measureTool)],
    }),
  );

  return (
    <CadProvider store={store}>
      <CadChainWorkbenchBody mode={mode} onModeChange={setMode} />
    </CadProvider>
  );
}

function CadChainWorkbenchBody({
  mode,
  onModeChange,
}: {
  readonly mode: "model" | "sketch";
  readonly onModeChange: (mode: "model" | "sketch") => void;
}): ReactElement {
  const store = useCadStore("CadChainWorkbenchPage");
  const documentApi = useCadDocument();
  const selectionApi = useCadSelection();
  const toolsApi = useCadTools();
  const historyApi = useCadHistory();
  const { arm } = toolsApi;
  const { beginRegeneration } = selectionApi;

  const [applied, setApplied] = useState<AppliedChainScene | null>(null);
  const [renderedFrames, setRenderedFrames] = useState(0);
  const sessionRef = useRef<ChainFixtureSession | null>(null);

  // -- The threaded regeneration loop (worker verdicts feed the domain) ---
  const [suppressed, setSuppressed] = useState<ReadonlySet<FeatureId>>(
    () => new Set(),
  );
  const [rollback, setRollback] = useState<FeatureRollbackPoint | null>(null);
  const [runState, setRunState] = useState<ChainRunState | null>(null);
  const [regenerationIssue, setRegenerationIssue] = useState<string | null>(
    null,
  );
  // The worker's recorded verdicts: empty after every settled dispatch
  // (everything present executed), one failed entry after a stage failure.
  const [outcomes, setOutcomes] = useState<WorkerOutcomes>(new Map());
  const [chainFailure, setChainFailure] = useState<ChainStageFailure | null>(
    null,
  );
  const previousRef = useRef<DerivationPrevious | null>(null);

  const workbenchDocument = documentApi.document;
  // The chain page's action guards (the composition rule made visible): the
  // scene request composes ONE extrude as the base and targets the newest
  // solid stage, so an extrude committed over holes (the base changes under
  // them) or over a fillet (the fillet's target stops being the last
  // extrude), and a hole committed over a fillet (the fillet's target stops
  // being the last hole), would leave `documentChainSceneRequest` null —
  // the dispatch effect would silently freeze on the last settled scene.
  // The buttons state that instead of committing the freeze; everything
  // else stays enabled (multiple holes without fillets compose legally),
  // and the dispatch effect's own null check remains as the
  // belt-and-braces invariant.
  const extrudeGuarded = nextExtrudeInvalidatesChain(workbenchDocument);
  const holeGuarded = nextHoleInvalidatesChain(workbenchDocument);
  const suppressedKey = useMemo(
    () =>
      [...suppressed]
        .map((id) => String(id))
        .sort()
        .join(","),
    [suppressed],
  );
  const rollbackKey = rollbackMarkerKey(rollback);

  useEffect(() => {
    const previous = previousRef.current;
    if (
      previous !== null &&
      previous.document === workbenchDocument &&
      previous.suppressedKey === suppressedKey &&
      previous.rollbackKey === rollbackKey &&
      previous.outcomes === outcomes
    ) {
      return;
    }
    const features = workbenchDocument.features;
    // The stale-marker clamp (the workbench engine's identical rule): a
    // marker whose anchor the document no longer declares (an undo removed
    // the anchored feature) clears itself and this pass runs the FULL
    // timeline instead of hard-failing every future pass on the dead
    // anchor. Start-of-timeline markers ({afterFeatureId: null}) never go
    // stale; valid markers keep today's parking semantics exactly.
    const rollbackPoint = clampedRollbackMarker(features, rollback);
    if (rollbackPoint === null && rollback !== null) {
      setRollback(null);
    }
    const changedNodes =
      previous === null || previous.document === workbenchDocument
        ? []
        : documentChangeInvalidations(previous.document, workbenchDocument);
    const verdictNodes =
      previous === null
        ? []
        : verdictInvalidations(previous.outcomes, outcomes);
    const states =
      previous === null
        ? initialRegenerationStates(features)
        : markStale(features, previous.states, [
            ...changedNodes,
            ...verdictNodes,
          ]);
    const run = regenerate({
      features,
      states,
      suppressed: [...suppressed],
      execute: (feature: FeatureRecord): FeatureExecutionOutcome => {
        const recorded = outcomes.get(feature.id);
        return recorded ?? structuralOutcome(workbenchDocument, feature);
      },
      rollbackPoint,
      results: previous?.results,
    });
    if (!run.ok) {
      setRegenerationIssue(run.error.message);
      return;
    }
    setRegenerationIssue(null);
    setRunState({
      states: run.value.states,
      results: run.value.results,
      executed: run.value.executed,
    });
    previousRef.current = {
      document: workbenchDocument,
      suppressedKey,
      // The CLAMPED key: the pass above ran with this marker, so the diff
      // baseline must say so — the state update that clears the stale
      // marker then lands as a no-op instead of a second pass.
      rollbackKey: rollbackMarkerKey(rollbackPoint),
      outcomes,
      states: run.value.states,
      results: run.value.results,
    };
  }, [
    workbenchDocument,
    suppressed,
    suppressedKey,
    rollback,
    rollbackKey,
    outcomes,
  ]);

  // -- The session boot: the OCCT worker executes the whole chain ---------
  useEffect(() => {
    arm(SELECT_TOOL_ID);
    const session = bootChainFixtureSession(
      {
        rootId: CHAIN_ROOT_ID,
        statusId: "chain-status",
        volumeId: "chain-volume",
        errorId: "chain-error",
      },
      (appliedView) => {
        setApplied(appliedView);
        // A NEW regeneration: synthetic references die with the old one.
        beginRegeneration(appliedView.revision);
        // The settled dispatch re-executed everything present: every
        // recorded verdict is superseded — the green state. Cleared only
        // when a verdict was actually recorded: an empty-for-empty swap
        // would re-run the derivation pass as a no-op and wipe the last
        // run's executed sequence for nothing.
        setOutcomes((current) => (current.size === 0 ? current : new Map()));
        setChainFailure((current) => (current === null ? current : null));
      },
      (failure) => {
        // The failed dispatch never became visible; the attributed feature
        // carries the worker's structured verdict, upstream keeps what it
        // already earned, and the failure rides the machine surface.
        setChainFailure(failure);
        setOutcomes((current) => {
          const next = new Map(current);
          next.set(failure.featureId, {
            ok: false,
            diagnostics: [
              {
                severity: "error",
                code: DIAGNOSTIC_CODES.kernelOperationFailed,
                message: failure.surfaceText(),
                location: { primary: failure.featureId },
              },
            ],
          });
          return next;
        });
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

  // -- The scene dispatch: every document change re-executes the chain ----
  useEffect(() => {
    const derived = documentChainSceneRequest(workbenchDocument);
    if (derived === null) return;
    sessionRef.current?.dispatch(derived.request, derived.bodyId);
  }, [workbenchDocument]);

  // -- The actions --------------------------------------------------------
  const [extrudeCount, setExtrudeCount] = useState(0);
  const [holeCount, setHoleCount] = useState(0);
  const [filletCount, setFilletCount] = useState(0);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);

  // The sketch → extrude action: the SAME atomic transaction the workbench
  // commits (sketch record, distance parameter, body, feature), then the
  // mode switch — the document change re-dispatches the chain (stage 1).
  const handleExtrude = useCallback(
    (submission: SketchExtrudeSubmission): void => {
      const n = extrudeCount + 1;
      const suffix = n === 1 ? "" : String(n);
      const sketchId = createSketchDocumentId(`skd_extrude${suffix}`);
      const parameterId = createParameterId(`param_extrude_depth${suffix}`);
      const bodyId = createBodyId(`body_extrude${suffix}`);
      const featureId = createFeatureId(`feat_extrude${suffix}`);
      const committed = documentApi.applyTransaction({
        commands: [
          {
            type: "sketch.create",
            id: sketchId,
            name: `extrude sketch ${String(n)}`,
            sketch: submission.sketch as unknown as Record<string, unknown>,
          },
          {
            type: "parameter.create",
            id: parameterId,
            name: `extrudeDepth${suffix}`,
            value: length(EXTRUDE_DEFAULT_DEPTH_MM),
          },
          { type: "body.create", id: bodyId, name: `pad ${String(n)}` },
          {
            type: "feature.create",
            id: featureId,
            kind: "extrude",
            inputs: [
              { kind: "sketch", id: sketchId },
              { kind: "parameter", id: parameterId },
            ],
            outputs: [bodyId],
          },
        ],
      });
      if (!committed.ok) return;
      setExtrudeCount(n);
      onModeChange("model");
    },
    [documentApi, extrudeCount, onModeChange],
  );

  // The hole action (the workbench's, on the chain document): commits the
  // five hole parameters, the body, and the hole feature targeting the
  // document's LAST extrude — the chain scene's base.
  const holeBase = useMemo(
    () => holeBaseFeatureOf(workbenchDocument),
    [workbenchDocument],
  );
  const handleHole = useCallback((): void => {
    const renderedBounds =
      applied === null
        ? undefined
        : renderedMeasurementOf(applied.scene).bounds;
    if (holeBase === undefined || renderedBounds === undefined) return;
    const n = holeCount + 1;
    const suffix = String(n);
    const position = defaultHolePosition(renderedBounds);
    const diameterId = createParameterId(`param_hole_diameter${suffix}`);
    const depthId = createParameterId(`param_hole_depth${suffix}`);
    const xId = createParameterId(`param_hole_x${suffix}`);
    const yId = createParameterId(`param_hole_y${suffix}`);
    const axisId = createParameterId(`param_hole_axis${suffix}`);
    const bodyId = createBodyId(`body_hole${suffix}`);
    const featureId = createFeatureId(`feat_hole${suffix}`);
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "parameter.create",
          id: diameterId,
          name: `holeDiameter${suffix}`,
          value: length(HOLE_DEFAULT_DIAMETER_MM),
        },
        {
          type: "parameter.create",
          id: depthId,
          name: `holeDepth${suffix}`,
          value: length(HOLE_DEFAULT_DEPTH_MM),
        },
        {
          type: "parameter.create",
          id: xId,
          name: `holeX${suffix}`,
          value: length(position.x),
        },
        {
          type: "parameter.create",
          id: yId,
          name: `holeY${suffix}`,
          value: length(position.y),
        },
        {
          type: "parameter.create",
          id: axisId,
          name: `holeAxis${suffix}`,
          value: dimensionless(HOLE_DEFAULT_AXIS),
        },
        { type: "body.create", id: bodyId, name: `holed ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "hole",
          inputs: [
            { kind: "feature", id: holeBase.id },
            { kind: "parameter", id: diameterId },
            { kind: "parameter", id: depthId },
            { kind: "parameter", id: xId },
            { kind: "parameter", id: yId },
            { kind: "parameter", id: axisId },
          ],
          outputs: [bodyId],
        },
      ],
    });
    if (!committed.ok) return;
    setHoleCount(n);
    setSelectedEdge(null);
  }, [applied, documentApi, holeBase, holeCount]);

  // The fillet action: commits the radius parameter, the picked snapshot
  // ordinal (a dimensionless parameter — the hole axis selector's
  // precedent), the body, and the fillet feature targeting the newest
  // solid stage. Needs a picked edge — the button states that.
  const filletBase = useMemo(
    () => filletBaseFeatureOf(workbenchDocument),
    [workbenchDocument],
  );
  const handleFillet = useCallback((): void => {
    if (filletBase === undefined || selectedEdge === null) return;
    const n = filletCount + 1;
    const suffix = String(n);
    const radiusId = createParameterId(`param_fillet_radius${suffix}`);
    const edgeId = createParameterId(`param_fillet_edge${suffix}`);
    const bodyId = createBodyId(`body_fillet${suffix}`);
    const featureId = createFeatureId(`feat_fillet${suffix}`);
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "parameter.create",
          id: radiusId,
          name: `filletRadius${suffix}`,
          value: length(CHAIN_FILLET_DEFAULT_RADIUS_MM),
        },
        {
          type: "parameter.create",
          id: edgeId,
          name: `filletEdge${suffix}`,
          value: dimensionless(selectedEdge),
        },
        { type: "body.create", id: bodyId, name: `rounded ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "fillet",
          inputs: [
            { kind: "feature", id: filletBase.id },
            { kind: "parameter", id: radiusId },
            { kind: "parameter", id: edgeId },
          ],
          outputs: [bodyId],
        },
      ],
    });
    if (!committed.ok) return;
    setFilletCount(n);
    setSelectedEdge(null);
  }, [documentApi, filletBase, filletCount, selectedEdge]);

  // -- Derived surfaces ----------------------------------------------------
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

  const toggleSuppressed = useCallback((id: FeatureId): void => {
    setSuppressed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const regenerationStates = runState === null ? null : runState.states;

  const projection = applied === null ? null : applied.render.projection;
  useEffect(() => {
    store.setProjection(projection);
  }, [projection, store]);

  const selectionKey = useMemo(
    () => selectionApi.selected.map(selectionReferenceKey).join(";"),
    [selectionApi.selected],
  );

  const faceAnchors = useMemo(
    () => (applied === null ? "" : faceAnchorSurface(applied.render)),
    [applied],
  );

  const edgeAnchors = useMemo(
    () => (applied === null ? "" : chainEdgeAnchorSurface(applied.scene)),
    [applied],
  );

  const measureText =
    toolsApi.completion !== null &&
    toolsApi.completion.detail.kind === "measurement"
      ? valueIn(toolsApi.completion.detail.distance, "mm").toFixed(3)
      : null;

  const stage = chainStageOf(workbenchDocument);

  const stageVolumes = useMemo(() => {
    if (applied === null) return "";
    const { scene } = applied;
    return JSON.stringify({
      extruded: scene.extruded.volume,
      holed: scene.holed === null ? null : scene.holed.volume,
      filleted: scene.filleted === null ? null : scene.filleted.volume,
    });
  }, [applied]);

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

  const chainFailureJson = useMemo(
    () =>
      chainFailure === null
        ? ""
        : JSON.stringify({
            stage: chainFailure.stage,
            featureId: chainFailure.featureId,
            code: chainFailure.kernelCode,
            message: chainFailure.surfaceText(),
          }),
    [chainFailure],
  );

  /** Selects the nearest anchor edge, or clears the pick when none is near. */
  const pickEdgeAt = useCallback(
    (clientX: number, clientY: number, viewport: DOMRect): void => {
      if (applied === null) return;
      const x = clientX - viewport.left;
      const y = clientY - viewport.top;
      const parsed = JSON.parse(edgeAnchors || "{}") as Record<
        string,
        ChainEdgeAnchor
      >;
      let best: { ordinal: number; distance: number } | null = null;
      for (const [ordinal, anchor] of Object.entries(parsed)) {
        const distance = Math.hypot(anchor.point[0] - x, anchor.point[1] - y);
        if (
          distance <= CHAIN_EDGE_PICK_RADIUS_PX &&
          (best === null || distance < best.distance)
        ) {
          best = { ordinal: Number(ordinal), distance };
        }
      }
      setSelectedEdge(best === null ? null : best.ordinal);
    },
    [applied, edgeAnchors],
  );

  return (
    <div
      id={CHAIN_ROOT_ID}
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
      data-history={JSON.stringify({
        canUndo: historyApi.canUndo,
        canRedo: historyApi.canRedo,
        cursor: historyApi.cursor,
        depth: historyApi.depth,
      })}
      data-feature-timeline={timelineJson}
      data-sketch-mode={mode}
      data-scene-kind="chain"
      data-chain-stage={stage}
      data-stage-volumes={stageVolumes}
      data-edge-anchors={edgeAnchors}
      data-selected-edge={selectedEdge === null ? "" : String(selectedEdge)}
      data-chain-failure={chainFailureJson}
      data-scene-extents={
        applied === null
          ? ""
          : formatBoundsExtents(renderedMeasurementOf(applied.scene).bounds)
      }
      data-scene-bounds={
        applied === null
          ? ""
          : JSON.stringify({
              min: renderedMeasurementOf(applied.scene).bounds.min.map((v) =>
                Number(v.toFixed(3)),
              ),
              max: renderedMeasurementOf(applied.scene).bounds.max.map((v) =>
                Number(v.toFixed(3)),
              ),
            })
      }
    >
      {/* The command row: tool strip, feature timeline, undo/redo, and the
          chain's solid actions (Hole, then the pick-driven Fillet). In
          sketch mode the row yields to the sketch editor; the model
          surfaces stay MOUNTED but hidden so the session's surface writer
          keeps the ids. */}
      <div
        className={`border-border bg-background h-10 shrink-0 items-center gap-2 border-b px-2 ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
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
              onRollback={setRollback}
              onToggleSuppressed={toggleSuppressed}
            />
          )}
        </div>
        <div className="flex-1" />
        <div
          aria-label="History"
          className="flex items-center gap-1"
          role="group"
        >
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
          data-testid="chain-hole"
          title={
            holeBase === undefined
              ? "Sketch and extrude a profile first — a hole cuts an existing solid."
              : holeGuarded
                ? "The chain rounds the newest solid stage — undo the fillet before cutting another hole."
                : "Cut a hole into the latest extrusion (defaults on the top face's center; edit holeDiameter/holeDepth/holeX/holeY in the parameter panel)."
          }
          disabled={holeBase === undefined || holeGuarded}
          onClick={handleHole}
          size="xs"
          type="button"
          variant="outline"
        >
          Hole
        </Button>
        <Button
          data-testid="chain-fillet"
          title={
            filletBase === undefined
              ? "Extrude a solid first — a fillet rounds an existing solid's edge."
              : selectedEdge === null
                ? "Pick an edge in the viewport first — the projected edge anchors are the target snapshot's addresses."
                : `Fillet the picked edge (ordinal ${String(selectedEdge)}) at filletRadius${String(filletCount + 1)} (default ${String(CHAIN_FILLET_DEFAULT_RADIUS_MM)} mm).`
          }
          disabled={filletBase === undefined || selectedEdge === null}
          onClick={handleFillet}
          size="xs"
          type="button"
          variant="outline"
        >
          Fillet
        </Button>
        <Button
          data-testid="chain-mode-toggle"
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
      {mode === "sketch" ? (
        <SketchMode
          extrudeDisabled={extrudeGuarded}
          extrudeDisabledTitle="The chain composes one extrusion as the solid stages' base — undo the holes and fillets built on it before extruding a new profile."
          onExit={() => {
            onModeChange("model");
          }}
          onExtrude={handleExtrude}
        />
      ) : null}
      {/* The workspace: tree palette left, viewport dominant, parameter
          palette right — the workbench's docked-palette layout. Hidden in
          sketch mode, but MOUNTED: the session's surface writers keep the
          ids alive. The viewport wrapper carries the edge-pick gesture (the
          fillet fixture's pick layer over the workbench's viewport). */}
      <div
        className={`min-h-0 flex-1 items-center justify-center p-3 ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        <div className="flex max-h-full min-h-0 items-start gap-3">
          <div className="flex w-48 shrink-0 flex-col gap-3">
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
                  <span id="chain-measure-readout" className="font-mono">
                    {`${measureText} mm`}
                  </span>
                )}
              </div>
            </section>
          </div>
          <div
            id="chain-viewport"
            className="shrink-0"
            data-face-anchors={faceAnchors}
            onPointerDown={(event) => {
              const viewport = event.currentTarget.getBoundingClientRect();
              pickEdgeAt(event.clientX, event.clientY, viewport);
            }}
          >
            <CadViewport
              className="h-[520px] w-[800px]"
              projection={applied === null ? null : applied.render.projection}
              onSettled={() => {
                // Settle protocol: pixels may be compared only once this
                // stamp agrees with the settled volume.
                document
                  .getElementById(CHAIN_ROOT_ID)
                  ?.setAttribute(
                    "data-cad-rendered-volume",
                    applied === null
                      ? ""
                      : renderedMeasurementOf(applied.scene).volume.toFixed(3),
                  );
                setRenderedFrames((frames) => frames + 1);
              }}
              onSelectionRendered={(key) => {
                document
                  .getElementById(CHAIN_ROOT_ID)
                  ?.setAttribute("data-cad-selection-frame", key);
              }}
            />
          </div>
          <div className="flex min-h-0 flex-1 flex-col self-stretch overflow-y-auto">
            <CadParameterPanel className="w-60 shrink-0" />
          </div>
        </div>
      </div>
      {/* Status bar: the settled numbers and the structured failure. */}
      <div
        className={`border-border bg-background text-muted-foreground h-7 shrink-0 items-center gap-4 border-t px-3 font-mono text-xs ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        <span>
          status ={" "}
          <span id="chain-status" data-testid="chain-status">
            boot
          </span>
        </span>
        <span>
          volume = <span id="chain-volume">…</span>
          {"\u00A0"}mm³
        </span>
        <span>stage = {stage}</span>
        <span>
          tool = {toolsApi.activeToolId ?? "none"} ({toolsApi.phase})
        </span>
        <span>selection = {selectionApi.selected.length}</span>
        <span>commands = {store.commandLog.length}</span>
        <span data-testid="chain-error" className="text-destructive">
          <span id="chain-error" />
        </span>
      </div>
    </div>
  );
}
