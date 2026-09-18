/**
 * The workbench engine (Phase 28): the data plane BOTH composed workbench
 * pages run on — the Phase 15/20/26/27 orchestration extracted verbatim
 * from the Phase 15 page so the established workbench and the Phase 28
 * complete composition stay one derivation apart from zero, exactly the
 * module discipline `workbench-extended-document.ts` set for the document
 * side. The engine owns NO markup: it returns the store (via
 * {@link useWorkbenchStore}, called ABOVE the `CadProvider`), the public
 * hook surfaces, the threaded regeneration state, the applied render
 * state, the timeline derivation, the inspection readouts, and the
 * create/rollback/suppression actions — each page renders its own layout
 * from those.
 *
 * ## What moved here (verbatim, per concern)
 *
 * - The store composition ({@link useWorkbenchStore}): one store over the
 *   workbench session with the select/measure/rotate tools registered.
 * - The Phase 20 threaded regeneration loop: on every document /
 *   suppression / rollback change it diffs the previous document into
 *   changed graph nodes, marks exactly those stale, and runs one
 *   `regenerate` pass with the executor stand-in.
 * - The session boot: the SELECT tool armed through the hook layer and the
 *   fixture worker session writing its settle surface into the ids the
 *   page names ({@link WorkbenchEngineSurface}).
 * - The scene dispatch: whichever computation the active scene names
 *   follows the DOCUMENT — plate (hole diameter), extrude, revolve, hole.
 * - The create actions (the sketch → solid UX bridges): extrude, revolve,
 *   and hole commit their atomic transactions and switch the scene.
 * - The readouts: selection key, face anchors, measure/distance/bounds/
 *   radius/mass-properties inspection states, and the machine timeline
 *   JSON.
 *
 * The host pushes the CURRENT projection into the store (the projection
 * access the active tool reads) — kept here, host-side state push, not
 * mirrored state.
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
  useCadDocument,
  useCadHistory,
  useCadSelection,
  useCadStore,
  useCadTools,
  valueIn,
} from "@slopcad/cad-react";
import {
  angle,
  createBodyId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  length,
} from "@slopcad/cad-core";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import {
  bootRenderFixtureSession,
  faceAnchorSurface,
  type RenderFixtureSession,
} from "../render-fixture/fixture-session";
import { holeDiameterMm } from "../workbench-fixture/workbench-document";
import { workbenchExecutor } from "../workbench-fixture/workbench-extended-document";
import { createCadWorkbenchSession } from "./session";
import { documentExtrudeRequest, type ExtrudeSceneRequest } from "./extrude";
import {
  defaultHolePosition,
  documentHoleSceneRequest,
  holeBaseFeatureOf,
  HOLE_DEFAULT_AXIS,
  HOLE_DEFAULT_DEPTH_MM,
  HOLE_DEFAULT_DIAMETER_MM,
} from "./hole";
import {
  documentRevolveRequest,
  type RevolveSceneRequest,
  type SketchRevolveSubmission,
} from "./revolve";
import {
  EXTRUDE_DEFAULT_DEPTH_MM,
  type SketchExtrudeSubmission,
} from "./SketchMode";
import { boundsReadout } from "./bounds-inspection";
import { distanceReadout } from "./distance-inspection";
import { massPropertiesReadout } from "./mass-properties-inspection";
import { radiusReadout } from "./radius-inspection";
import { WORKBENCH_SESSION_BACKEND } from "../render-fixture/session-backend";

/** The workbench's top-level modes: the 3D model workspace or the sketch. */
export type WorkbenchMode = "model" | "sketch";

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

/** The session settle-surface ids the booted fixture session writes into. */
export interface WorkbenchEngineSurface {
  /** The element receiving the settle `data-*` attributes. */
  readonly rootId: string;
  /** The status span the session writer updates. */
  readonly statusId: string;
  /** The volume span the session writer updates. */
  readonly volumeId: string;
  /** The error span the session writer updates. */
  readonly errorId: string;
}

/**
 * Creates the workbench store: one store over the workbench session (the
 * plate, the bore diameter, the translate + rotate chain, the
 * expression-driven `volumeHint`) with the tools the document supports
 * registered. Call ONCE above the `CadProvider`.
 */
export function useWorkbenchStore() {
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
  return store;
}

/** Everything the composed workbench pages render from. */
export interface WorkbenchEngine {
  /** The page-level mode: the model workspace or the sketch editor. */
  readonly mode: WorkbenchMode;
  readonly setMode: (mode: WorkbenchMode) => void;
  /** The store (for the command log and the projection push reads). */
  readonly store: ReturnType<typeof useCadStore>;
  readonly documentApi: ReturnType<typeof useCadDocument>;
  readonly selectionApi: ReturnType<typeof useCadSelection>;
  readonly toolsApi: ReturnType<typeof useCadTools>;
  readonly historyApi: ReturnType<typeof useCadHistory>;
  /** The applied render state, or `null` before the first settle. */
  readonly applied: AppliedRenderState | null;
  /** The settled render-frame count (the scene's frame counter). */
  readonly renderedFrames: number;
  /**
   * Counts one settled projection frame and synchronously stamps the
   * scene's settle volume (or `null` to count only — a frame that does not
   * belong to the document projection must not stamp it).
   */
  readonly noteRenderedFrame: (stampVolume: string | null) => void;
  /** The suppressed feature set (authoring data, page-level). */
  readonly suppressed: ReadonlySet<FeatureId>;
  /** The rollback marker, or `null`. */
  readonly rollback: FeatureRollbackPoint | null;
  readonly setRollback: (rollback: FeatureRollbackPoint | null) => void;
  /** Toggles one feature's suppression (the timeline chip's action). */
  readonly toggleSuppressed: (id: FeatureId) => void;
  /** The threaded loop's durable state map (tree/timeline statuses). */
  readonly regenerationStates: RegenerationStateMap | null;
  /** The joined timeline entries, or `null` before the first run. */
  readonly timeline: readonly FeatureTimelineEntry[] | null;
  /** The last run's executed sequence (the timeline strip's prop). */
  readonly executed: readonly FeatureId[];
  /** The last derivation failure, or `null`. */
  readonly regenerationIssue: string | null;
  /** The document's last extrude feature (the next hole's base). */
  readonly holeBase: ReturnType<typeof holeBaseFeatureOf>;
  /** The document's stored hole diameter, or `null`. */
  readonly storedHole: number | null;
  /** The active scene kind the dispatch effect follows. */
  readonly activeScene: "plate" | "extrude" | "revolve" | "hole";
  /**
   * Switches the active scene kind. A host whose authoring actions can
   * INVALIDATE the active scene (e.g. a feature removal that leaves the
   * scene request unresolved) falls back honestly: point the dispatch at
   * the plate scene rather than leave stale pixels up.
   */
  readonly setActiveScene: (
    scene: "plate" | "extrude" | "revolve" | "hole",
  ) => void;
  /** The face-anchor surface JSON of the applied projection. */
  readonly faceAnchors: string;
  /** The measure tool's point-pair completion text, or `null`. */
  readonly measureText: string | null;
  /** The Phase 27 inspection readouts (see the inspection modules). */
  readonly boundsState: ReturnType<typeof boundsReadout>;
  readonly referenceDistance: ReturnType<typeof distanceReadout>;
  readonly radiusState: ReturnType<typeof radiusReadout>;
  readonly massPropertiesState: ReturnType<typeof massPropertiesReadout>;
  /** The machine timeline JSON (rollback, entries, executed). */
  readonly timelineJson: string;
  /** The extrude create action (the sketch → solid UX bridge). */
  readonly handleExtrude: (submission: SketchExtrudeSubmission) => void;
  /** The revolve create action (the sketch → solid UX bridge). */
  readonly handleRevolve: (submission: SketchRevolveSubmission) => void;
  /** The hole create action (parameter-panel-driven defaults). */
  readonly handleHole: () => void;
}

/**
 * Runs the workbench engine below a `CadProvider`: the store's public hook
 * surfaces, the threaded regeneration loop, the booted worker session
 * writing its settle surface into `surface`, the scene dispatch, the
 * create actions, and the inspection readouts.
 */
export function useWorkbenchEngine(
  surface: WorkbenchEngineSurface,
): WorkbenchEngine {
  const { rootId, statusId, volumeId, errorId } = surface;
  // The workbench mode is page-level authoring state: the model workspace
  // keeps its worker session alive across switches (hidden, not unmounted).
  const [mode, setMode] = useState<WorkbenchMode>("model");
  const store = useCadStore("useWorkbenchEngine");
  const documentApi = useCadDocument();
  const selectionApi = useCadSelection();
  const toolsApi = useCadTools();
  const historyApi = useCadHistory();
  const { arm } = toolsApi;
  const { beginRegeneration } = selectionApi;

  const [applied, setApplied] = useState<AppliedRenderState | null>(null);
  const [renderedFrames, setRenderedFrames] = useState(0);
  const sessionRef = useRef<RenderFixtureSession | null>(null);

  /**
   * Counts one settled projection frame and — synchronously, in the
   * settle callback itself (the Phase 15 page's exact original semantics,
   * which the render suite's byte-stable baselines pin) — writes the
   * scene's settle stamp into the root's `data-cad-rendered-volume`. The
   * caller passes the volume text to stamp, or `null` to count only (a
   * frame whose pixels belong to a DIFFERENT projection, e.g. an imported
   * mesh preview, must not stamp the document's settle surface).
   */
  const noteRenderedFrame = (stampVolume: string | null): void => {
    if (stampVolume !== null) {
      document
        .getElementById(rootId)
        ?.setAttribute("data-cad-rendered-volume", stampVolume);
    }
    setRenderedFrames((frames) => frames + 1);
  };

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

  // The Phase 26.1/26.2/26.10 scene state: the plate computation until the
  // first solid action commits a feature; afterwards the worker executes
  // the document's extrude, revolve, or hole composition (parameter edits
  // re-dispatch).
  const [activeScene, setActiveScene] = useState<
    "plate" | "extrude" | "revolve" | "hole"
  >("plate");
  const [extrudeCount, setExtrudeCount] = useState(0);
  const [revolveCount, setRevolveCount] = useState(0);
  const [holeCount, setHoleCount] = useState(0);

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

  // The Phase 26.1 extrude action (the sketch → solid UX bridge): commit
  // the sketch record, the distance parameter, the output body, and the
  // extrude feature in ONE atomic transaction, then switch the scene to the
  // worker-executed extrusion and return to the model workspace. A refused
  // transaction keeps everything unchanged.
  const handleExtrude = (submission: SketchExtrudeSubmission): void => {
    const n = extrudeCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const sketchId = createSketchDocumentId(`skd_extrude${suffix}`);
    const parameterId = createParameterId(`param_extrude_depth${suffix}`);
    const bodyId = createBodyId(`body_extrude${suffix}`);
    const featureId = createFeatureId(`feat_extrude${suffix}`);
    const applied = documentApi.applyTransaction({
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
    if (!applied.ok) return;
    setExtrudeCount(n);
    setActiveScene("extrude");
    setMode("model");
  };

  // The Phase 26.2 revolve action (the sketch → solid UX bridge): commit
  // the sketch record, the SWEEP and AXIS angle parameters, the output
  // body, and the revolve feature in ONE atomic transaction, then switch
  // the scene to the worker-executed revolution and return to the model
  // workspace. A refused transaction keeps everything unchanged. The axis
  // is a line through the workplane origin along the direction angle the
  // sketch mode's selector pinned (see ./revolve).
  const handleRevolve = (submission: SketchRevolveSubmission): void => {
    const n = revolveCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const sketchId = createSketchDocumentId(`skd_revolve${suffix}`);
    const sweepId = createParameterId(`param_revolve_sweep${suffix}`);
    const axisId = createParameterId(`param_revolve_axis${suffix}`);
    const bodyId = createBodyId(`body_revolve${suffix}`);
    const featureId = createFeatureId(`feat_revolve${suffix}`);
    const applied = documentApi.applyTransaction({
      commands: [
        {
          type: "sketch.create",
          id: sketchId,
          name: `revolve sketch ${String(n)}`,
          sketch: submission.sketch as unknown as Record<string, unknown>,
        },
        {
          type: "parameter.create",
          id: sweepId,
          name: `revolveSweep${suffix}`,
          value: angle(submission.sweepRad, "rad"),
        },
        {
          type: "parameter.create",
          id: axisId,
          name: `revolveAxis${suffix}`,
          value: angle(submission.axisDirectionRad, "rad"),
        },
        { type: "body.create", id: bodyId, name: `revolved ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "revolve",
          inputs: [
            { kind: "sketch", id: sketchId },
            { kind: "parameter", id: sweepId },
            { kind: "parameter", id: axisId },
          ],
          outputs: [bodyId],
        },
      ],
    });
    if (!applied.ok) return;
    setRevolveCount(n);
    setActiveScene("revolve");
    setMode("model");
  };

  // The Phase 26.10 hole action (the solid → hole UX bridge): commit the
  // five hole parameters (diameter, depth, position x/y, axis — the
  // bridge's parameter roles in declared order) and the hole feature in ONE
  // atomic transaction, targeting the document's LAST extrude feature (the
  // scene composition's base). The position defaults to the rendered top
  // face's center — parameter-panel-driven authoring; every dimension is
  // then a `parameter.set` away (the plan's regeneration criterion). A
  // refused transaction keeps everything unchanged.
  const holeBase = useMemo(
    () => holeBaseFeatureOf(workbenchDocument),
    [workbenchDocument],
  );
  const handleHole = (): void => {
    const bounds = applied?.state.measurement.bounds;
    if (holeBase === undefined || bounds === undefined) return;
    const n = holeCount + 1;
    // Unlike extrude/revolve, the FIRST hole's parameters carry their index
    // too: the Phase 15 plate fixture document already owns the unsuffixed
    // `holeDiameter` parameter name, and a name conflict would refuse the
    // whole transaction.
    const suffix = String(n);
    const position = defaultHolePosition(bounds);
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
    setActiveScene("hole");
  };

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

  // The boot reads the surface ids as flat deps: a page may pass a fresh
  // object each render — only the IDENTITY of each id reboots the session.
  useEffect(() => {
    // The host's explicit boot configuration: the SELECT tool armed through
    // the hook layer (cancel-if-active, reset, activate).
    arm(SELECT_TOOL_ID);
    const session = bootRenderFixtureSession(
      {
        rootId,
        statusId,
        volumeId,
        errorId,
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
  }, [arm, beginRegeneration, rootId, statusId, volumeId, errorId]);

  // The scene dispatch: whichever computation the active scene names follows
  // the DOCUMENT (the parameter edit → regenerate criterion) — the plate
  // scene follows the hole diameter, the extrude scene re-reads the
  // document's extrude feature through the profile resolver, the hole scene
  // re-reads the hole composition (base extrusion + every hole's five
  // parameters). Declared AFTER the boot effect above so the mount pass
  // runs with the session already in sessionRef — the initial plate
  // dispatch fires, and later action re-triggers (extrudeCount, revolveCount,
  // holeCount) re-dispatch the current scene.
  useEffect(() => {
    if (activeScene === "extrude") {
      const request: ExtrudeSceneRequest | null =
        documentExtrudeRequest(workbenchDocument);
      if (request !== null) {
        sessionRef.current?.dispatchExtrude(request, request.bodyId);
      }
      return;
    }
    if (activeScene === "revolve") {
      const request: RevolveSceneRequest | null =
        documentRevolveRequest(workbenchDocument);
      if (request !== null) {
        sessionRef.current?.dispatchRevolve(request, request.bodyId);
      }
      return;
    }
    if (activeScene === "hole") {
      const derived = documentHoleSceneRequest(workbenchDocument);
      if (derived !== null) {
        sessionRef.current?.dispatchHole(derived.request, derived.bodyId);
      }
      return;
    }
    if (storedHole !== null) {
      sessionRef.current?.dispatch(storedHole);
    }
  }, [
    activeScene,
    workbenchDocument,
    storedHole,
    extrudeCount,
    revolveCount,
    holeCount,
  ]);

  // The host pushes the CURRENT projection into the store — the projection
  // access the active tool reads. Host-side state push, not mirrored state.
  useEffect(() => {
    store.setProjection(applied === null ? null : applied.state.projection);
  }, [applied, store]);

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

  // The bounds inspection (Phase 27.1): the scene solid's kernel-measured
  // bounds displayed when the selection resolves to exactly the measured
  // body, with the booted kernel's declared tightness (see
  // ./bounds-inspection).
  const boundsState = boundsReadout({
    selected: selectionApi.selected,
    features: workbenchDocument.features,
    sceneBodyId:
      applied === null
        ? undefined
        : applied.state.projection.objects.find(
            (object) => object.bodyId !== undefined,
          )?.bodyId,
    bounds: applied === null ? undefined : applied.state.measurement.bounds,
    tightBooleanBounds: WORKBENCH_SESSION_BACKEND.tightBooleanBounds,
  });

  // The distance inspection (Phase 27.2): the selection's reference pair —
  // exactly two selected references — measured through the reference
  // matrix (see ./distance-inspection).
  const referenceDistance = distanceReadout({
    selected: selectionApi.selected,
    features: workbenchDocument.features,
    projection: applied === null ? undefined : applied.state.projection,
  });

  // The radius inspection (Phase 27.3): exactly one selected reference —
  // measured through the radius support matrix (see ./radius-inspection).
  const radiusState = radiusReadout({
    selected: selectionApi.selected,
    features: workbenchDocument.features,
    projection: applied === null ? undefined : applied.state.projection,
  });

  // The mass-properties inspection (Phase 27.4): the scene solid's
  // kernel-measured volume and surface area (see
  // ./mass-properties-inspection).
  const massPropertiesState = massPropertiesReadout({
    selected: selectionApi.selected,
    features: workbenchDocument.features,
    sceneBodyId:
      applied === null
        ? undefined
        : applied.state.projection.objects.find(
            (object) => object.bodyId !== undefined,
          )?.bodyId,
    volume: applied === null ? undefined : applied.state.measurement.volume,
    area: applied === null ? undefined : applied.state.measurement.area,
  });

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

  return {
    mode,
    setMode,
    store,
    documentApi,
    selectionApi,
    toolsApi,
    historyApi,
    applied,
    renderedFrames,
    noteRenderedFrame,
    suppressed,
    rollback,
    setRollback,
    toggleSuppressed,
    regenerationStates: runState === null ? null : runState.states,
    timeline,
    executed: runState === null ? [] : runState.executed,
    regenerationIssue,
    holeBase,
    storedHole,
    activeScene,
    setActiveScene,
    faceAnchors,
    measureText,
    boundsState,
    referenceDistance,
    radiusState,
    massPropertiesState,
    timelineJson,
    handleExtrude,
    handleRevolve,
    handleHole,
  };
}

/**
 * The provider wrapper both composed workbench pages mount: the store is
 * created once above the provider, exactly the Phase 15 page's structure.
 */
export function WorkbenchStoreProvider({
  children,
}: {
  readonly children: ReactElement;
}): ReactElement {
  const store = useWorkbenchStore();
  return <CadProvider store={store}>{children}</CadProvider>;
}
