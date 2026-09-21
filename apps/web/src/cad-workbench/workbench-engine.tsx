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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  CadProvider,
  createCadStore,
  DIAGNOSTIC_CODES,
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
  createDatumId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  length,
  parseDatumPayload,
  type DatumId,
} from "@slopcad/cad-core";
import type { KernelResolvedProfile } from "@slopcad/cad-kernel";
import type { Workplane } from "@slopcad/cad-sketch";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import {
  bootRenderFixtureSession,
  faceAnchorSurface,
  type RenderFixtureSession,
  type SceneDispatchOutcome,
} from "../render-fixture/fixture-session";
import { holeDiameterMm } from "../workbench-fixture/workbench-document";
import { workbenchExecutor } from "../workbench-fixture/workbench-extended-document";
import { createCadWorkbenchSession } from "./session";
import {
  documentExtrudeRequest,
  documentPadSceneRequest,
  sketchProfileResolverOf,
  type ExtrudeSceneRequest,
} from "./extrude";
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
  documentSweepRequest,
  sketchPathResolverOf,
  validateSweepSubmission,
  type SweepSceneRequest,
} from "./sweep";
import {
  documentLoftRequest,
  validateLoftSubmission,
  type LoftSceneRequest,
  type LoftSectionChoice,
} from "./loft";
import {
  EXTRUDE_DEFAULT_DEPTH_MM,
  type SketchExtrudeSubmission,
} from "./SketchMode";
import {
  resolveSessionDatumPlane,
  sceneFacePickOfSelection,
  sessionFaceReferenceOf,
  type SceneFacePick,
} from "./datum";
import { boundsReadout } from "./bounds-inspection";
import { distanceReadout } from "./distance-inspection";
import { massPropertiesReadout } from "./mass-properties-inspection";
import { radiusReadout } from "./radius-inspection";
import { clampedRollbackMarker, rollbackMarkerKey } from "./rollback-marker";
import {
  sessionBackendOf,
  type FixtureSessionBackendId,
} from "../render-fixture/session-backend";

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

/**
 * The session settle-surface ids the booted fixture session writes into,
 * plus the worker backend the session boots (default `"manifold"` — the
 * boot state every established baseline pins; the sweep-capable
 * composition boots `"occt"`, Phase 38).
 */
export interface WorkbenchEngineSurface {
  /** The element receiving the settle `data-*` attributes. */
  readonly rootId: string;
  /** The status span the session writer updates. */
  readonly statusId: string;
  /** The volume span the session writer updates. */
  readonly volumeId: string;
  /** The error span the session writer updates. */
  readonly errorId: string;
  /** The worker backend the session boots. */
  readonly backend?: FixtureSessionBackendId;
  /**
   * The viewport element whose CANVAS the face anchors project into. A
   * fluid-viewport host passes its id so the anchor projection reads the
   * LIVE canvas size (the scene camera consumes the live aspect — a fixed
   * 800×520 projection drifts off the geometry at any other size). A host
   * whose viewport IS the fixture's fixed 800×520 box omits it and keeps
   * the authored frame (byte-identical anchors).
   */
  readonly viewportId?: string;
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

/**
 * The scene kinds the dispatch effect follows — the plate computation until
 * the first solid action commits, then the worker-executed composition the
 * document names (Phase 38 adds the sweep and loft scenes).
 */
export type WorkbenchSceneKind =
  "plate" | "extrude" | "revolve" | "sweep" | "loft" | "hole";

/**
 * The structured outcome of a feature-form submission: the domain's refusal
 * verbatim, or success (the transaction committed and the scene switched).
 */
export type FeatureFormOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The active scene feature's worker refusal — the timeline's verdict seam:
 *  the document-data executor judges document inputs alone and cannot know
 *  a kernel declined an operation, so the session's structured refusal
 *  (Phase 38: Manifold's `kernel/unsupported-operation` for sweep/loft)
 *  rides here and the timeline joins it into the feature's status. */
export interface SceneFeatureFailure {
  /** The refused dispatch's output body id (resolved at join time). */
  readonly bodyId: string;
  /** The verbatim error-surface text (the chip title can't contradict it). */
  readonly text: string;
}

/**
 * Joins the worker's build verdict into the regeneration states the
 * timeline reads: the feature that owns the refused dispatch's output body
 * is marked `failed` with the registered kernel-operation-failed code and
 * the error surface's exact text as its diagnostic message — the same
 * presentation a refused executor pass gets, so the chip follows the
 * existing failure conventions. The pass's own states are untouched
 * (suppression and rollback still win in the joined view), and a body the
 * document no longer declares — an undo removed the feature — resolves to
 * no override at all.
 */
export function sceneVerdictAdjustedStates(
  states: RegenerationStateMap,
  document: CadDocument,
  failure: SceneFeatureFailure,
): RegenerationStateMap {
  const feature = document.features.find((entry) =>
    entry.outputs.some((output) => output === failure.bodyId),
  );
  if (feature === undefined) return states;
  const adjusted = new Map(states);
  adjusted.set(feature.id, {
    state: "failed",
    diagnostics: [
      {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelOperationFailed,
        message: failure.text,
        location: { primary: feature.id },
      },
    ],
  });
  return adjusted;
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
  readonly activeScene: WorkbenchSceneKind;
  /**
   * Switches the active scene kind. A host whose authoring actions can
   * INVALIDATE the active scene (e.g. a feature removal that leaves the
   * scene request unresolved) falls back honestly: point the dispatch at
   * the plate scene rather than leave stale pixels up.
   */
  readonly setActiveScene: (scene: WorkbenchSceneKind) => void;
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
  /**
   * The Phase 38 save-sketch action: commits the CURRENT sketch as a
   * STANDALONE document sketch record (no feature) — the sketch pool the
   * sweep and loft forms pick from. Exits to the model workspace.
   */
  readonly handleSaveSketch: (submission: { readonly sketch: unknown }) => void;
  /**
   * The Phase 38 sweep create action: validates the picked profile + path
   * sketches through the action-time battery, then commits the sweep
   * feature in one atomic transaction and switches the scene. A refusal
   * commits nothing and returns the structured outcome for the form.
   */
  readonly handleSweep: (
    profileSketchId: string,
    pathSketchId: string,
  ) => FeatureFormOutcome;
  /**
   * The Phase 38 loft create action: validates the picked ordered sections
   * (shared frame, strictly increasing stations), then commits the station
   * parameters and the loft feature in one atomic transaction. A refusal
   * commits nothing and returns the structured outcome for the form.
   */
  readonly handleLoft: (
    sections: readonly LoftSectionChoice[],
  ) => FeatureFormOutcome;
  /**
   * The Phase 39 sketch-on-face action: resolves the picked scene face into
   * a datum plane record (the persistent anchor) plus the face workplane,
   * commits the datum in one atomic transaction, and enters the sketch mode
   * booted on that workplane. A structured refusal (curved face, unsettled
   * scene, refused transaction) changes nothing and carries the message for
   * the caller's status surface.
   */
  readonly handleSketchOnFace: (reference: {
    readonly kind: "face";
    readonly bodyId: string;
    readonly faceIndex: number;
  }) =>
    { readonly ok: true } | { readonly ok: false; readonly message: string };
  /**
   * The Phase 39 datum creation action (the Formedible form's submission
   * seam): validates the payload through the datum module's parser, then
   * commits the datum.create command. A refusal commits nothing.
   */
  readonly handleCreateDatum: (
    payload: Record<string, unknown>,
  ) => FeatureFormOutcome;
  /**
   * The workplane the CURRENT sketch session boots on — the datum plane's
   * frame in sketch-on-face mode, `null` in the ordinary (XY) flow.
   */
  readonly sketchBootWorkplane: Workplane | null;
  /**
   * The document's datum records with their session-resolved planes, as
   * canonical JSON for the machine surface (empty array when none).
   */
  readonly datumsJson: string;
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
  const { rootId, statusId, volumeId, errorId, backend, viewportId } = surface;
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
  const [activeScene, setActiveScene] = useState<WorkbenchSceneKind>("plate");
  const [extrudeCount, setExtrudeCount] = useState(0);
  const [revolveCount, setRevolveCount] = useState(0);
  const [holeCount, setHoleCount] = useState(0);
  const [sketchCount, setSketchCount] = useState(0);
  const [sweepCount, setSweepCount] = useState(0);
  const [loftCount, setLoftCount] = useState(0);
  // The Phase 39 sketch-on-face anchor: the datum record the CURRENT sketch
  // session boots on (its id commits with the extrude feature; its plane
  // booted the sketch editor). `null` in the ordinary sketch flow.
  const [sketchAnchor, setSketchAnchor] = useState<{
    readonly datumId: DatumId;
    readonly workplane: Workplane;
  } | null>(null);
  const [datumCount, setDatumCount] = useState(0);

  // The active scene feature's worker refusal (Phase 38 capability
  // honesty): the session reports every feature-backed dispatch's verdict,
  // and a refusal maps onto the owning feature's timeline status — the
  // chip reads Failed beside the error surface that carries the refusal,
  // never Valid. A successful dispatch clears it, so a re-drive that
  // builds recovers the chip.
  const [sceneFeatureFailure, setSceneFeatureFailure] =
    useState<SceneFeatureFailure | null>(null);
  const onSceneOutcome = useCallback((outcome: SceneDispatchOutcome): void => {
    if (outcome.ok) {
      setSceneFeatureFailure(null);
      return;
    }
    setSceneFeatureFailure({
      bodyId: outcome.bodyId,
      text: outcome.text,
    });
  }, []);

  const workbenchDocument = documentApi.document;
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
      previous.rollbackKey === rollbackKey
    ) {
      return;
    }
    const features = workbenchDocument.features;
    // The stale-marker clamp: a marker whose anchor the document no longer
    // declares (an undo removed the anchored feature, an older version was
    // opened) clears itself and this pass runs the FULL timeline instead of
    // hard-failing every future pass on the dead anchor. Start-of-timeline
    // markers ({afterFeatureId: null}) never go stale; valid markers keep
    // today's parking semantics exactly.
    const rollbackPoint = clampedRollbackMarker(features, rollback);
    if (rollbackPoint === null && rollback !== null) {
      setRollback(null);
    }
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
      rollbackPoint,
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
      // The CLAMPED key: the pass above ran with this marker, so the diff
      // baseline must say so — the state update that clears the stale
      // marker then lands as a no-op instead of a second pass.
      rollbackKey: rollbackMarkerKey(rollbackPoint),
      states: applied.value.states,
      results: applied.value.results,
    };
  }, [workbenchDocument, suppressed, suppressedKey, rollback, rollbackKey]);

  // The Phase 26.1 extrude action (the sketch → solid UX bridge): commit
  // the sketch record, the distance parameter, the output body, and the
  // extrude feature in ONE atomic transaction, then switch the scene to the
  // worker-executed extrusion and return to the model workspace. A refused
  // transaction keeps everything unchanged. When the sketch session was
  // anchored on a datum (sketch-on-face, Phase 39), the feature ALSO
  // declares the datum as an input — the live anchor the scene re-resolves
  // on every dispatch (edit driving face — geometry follows).
  const handleExtrude = (submission: SketchExtrudeSubmission): void => {
    const n = extrudeCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const sketchId = createSketchDocumentId(`skd_extrude${suffix}`);
    const parameterId = createParameterId(`param_extrude_depth${suffix}`);
    const bodyId = createBodyId(`body_extrude${suffix}`);
    const featureId = createFeatureId(`feat_extrude${suffix}`);
    const datumInput =
      sketchAnchor === null
        ? []
        : [{ kind: "datum" as const, id: sketchAnchor.datumId }];
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
            ...datumInput,
          ],
          outputs: [bodyId],
        },
      ],
    });
    if (!applied.ok) return;
    setExtrudeCount(n);
    setActiveScene("extrude");
    // Through the wrapped setter: the extrude consumed the sketch anchor, and
    // a raw setMode would leave it alive to re-attach the NEXT sketch.
    wrappedSetMode("model");
  };

  // The Phase 39 sketch-on-face action: resolve the picked scene face into
  // a datum plane record (the persistent anchor), commit it, then boot the
  // sketch editor on the datum's RESOLVED frame — the same frame every
  // re-derivation computes, so what the author draws is what re-drives
  // when the face moves (no anchor-vs-resolution coordinate jump). A
  // curved face (no single normal) is refused structurally — no guessed
  // plane.
  const handleSketchOnFace = (reference: {
    readonly kind: "face";
    readonly bodyId: string;
    readonly faceIndex: number;
  }):
    | { readonly ok: true }
    | { readonly ok: false; readonly message: string } => {
    if (applied === null) {
      return {
        ok: false,
        message: "The scene has not settled; nothing to sketch on yet.",
      };
    }
    const pick: SceneFacePick | null = sceneFacePickOfSelection(
      applied.state.projection,
      reference,
    );
    if (pick === null || pick.normal === null) {
      return {
        ok: false,
        message:
          "The picked face has no single normal (a curved or vanished face); sketch-on-face needs a planar face.",
      };
    }
    const referencePayload = sessionFaceReferenceOf(pick);
    if (referencePayload === null) {
      return {
        ok: false,
        message: "The picked face cannot anchor a datum plane.",
      };
    }
    const n = datumCount + 1;
    const datumId = createDatumId(`dtm_face_plane${n === 1 ? "" : String(n)}`);
    const commit = documentApi.applyTransaction({
      commands: [
        {
          type: "datum.create",
          id: datumId,
          name: `face plane ${String(n)}`,
          datum: {
            formatVersion: 1,
            datumType: "plane",
            definition: "faceOffset",
            reference: referencePayload,
            normalAtDefinition: [
              pick.normal[0],
              pick.normal[1],
              pick.normal[2],
            ],
            offsetMm: 0,
          },
        },
      ],
    });
    if (!commit.ok) {
      return { ok: false, message: commit.error.message };
    }
    // Boot the sketch on the datum's RESOLVED plane — the resolution the
    // scene request re-derives on every dispatch.
    const plane = resolveSessionDatumPlane(commit.value.document, datumId);
    if (!plane.ok) {
      return { ok: false, message: plane.error.message };
    }
    setDatumCount(n);
    setSketchAnchor({
      datumId,
      workplane: {
        origin: { x: plane.origin[0], y: plane.origin[1], z: plane.origin[2] },
        normal: { x: plane.normal[0], y: plane.normal[1], z: plane.normal[2] },
        xAxis: { x: plane.xAxis[0], y: plane.xAxis[1], z: plane.xAxis[2] },
      },
    });
    setMode("sketch");
    return { ok: true };
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
    wrappedSetMode("model");
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

  // The Phase 38 save-sketch action: commit the CURRENT sketch as a
  // STANDALONE document sketch record (no feature — the sketch pool the
  // sweep and loft forms pick from) and exit to the model workspace, where
  // the feature forms live. A refused transaction keeps everything
  // unchanged.
  const handleSaveSketch = (submission: { readonly sketch: unknown }): void => {
    const n = sketchCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const applied = documentApi.applyTransaction({
      commands: [
        {
          type: "sketch.create",
          id: createSketchDocumentId(`skd_sketch${suffix}`),
          name: `sketch ${String(n)}`,
          sketch: submission.sketch as Record<string, unknown>,
        },
      ],
    });
    if (!applied.ok) return;
    setSketchCount(n);
    wrappedSetMode("model");
  };

  // The Phase 38 sweep action: resolve the picked profile and path sketches
  // through the same resolver seams the executor bridge uses, run the
  // kernel's sweep battery BEFORE anything commits (the revolve action's
  // validation-seam precedent), then commit the feature in ONE atomic
  // transaction and switch the scene. A refusal commits nothing and hands
  // the structured outcome back to the form.
  const handleSweep = (
    profileSketchId: string,
    pathSketchId: string,
  ): FeatureFormOutcome => {
    if (profileSketchId === pathSketchId) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "The sweep profile and the sweep path must be different sketches; one sketch cannot be both the loop and its spine.",
      };
    }
    const profile = sketchProfileResolverOf(workbenchDocument)(
      createSketchDocumentId(profileSketchId),
    );
    if (!profile.ok) {
      return {
        ok: false,
        code: profile.error.code,
        message: profile.error.message,
      };
    }
    const path = sketchPathResolverOf(workbenchDocument)(
      createSketchDocumentId(pathSketchId),
    );
    if (!path.ok) {
      return {
        ok: false,
        code: path.error.code,
        message: path.error.message,
      };
    }
    const validation = validateSweepSubmission({
      loop: profile.value.loop,
      path: path.value.path,
    });
    if (!validation.ok) return validation;
    const n = sweepCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_sweep${suffix}`);
    const featureId = createFeatureId(`feat_sweep${suffix}`);
    const committed = documentApi.applyTransaction({
      commands: [
        { type: "body.create", id: bodyId, name: `swept ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "sweep",
          inputs: [
            { kind: "sketch", id: createSketchDocumentId(profileSketchId) },
            { kind: "sketch", id: createSketchDocumentId(pathSketchId) },
          ],
          outputs: [bodyId],
        },
      ],
    });
    if (!committed.ok) {
      return {
        ok: false,
        code: committed.error.code,
        message: committed.error.message,
      };
    }
    setSweepCount(n);
    setActiveScene("sweep");
    return { ok: true };
  };

  // The Phase 38 loft action: resolve the picked ordered sections (shared
  // frame, strictly increasing stations — the action-time twin of the
  // bridge's rules), then commit the station parameters and the loft
  // feature in ONE atomic transaction. A refusal commits nothing.
  const handleLoft = (
    sections: readonly LoftSectionChoice[],
  ): FeatureFormOutcome => {
    const resolveProfile = sketchProfileResolverOf(workbenchDocument);
    const resolvedSections: {
      readonly choice: LoftSectionChoice;
      readonly placement: KernelResolvedProfile["placement"];
    }[] = [];
    for (const choice of sections) {
      const resolution = resolveProfile(
        createSketchDocumentId(choice.sketchId),
      );
      if (!resolution.ok) {
        return {
          ok: false,
          code: resolution.error.code,
          message: resolution.error.message,
        };
      }
      resolvedSections.push({ choice, placement: resolution.value.placement });
    }
    const validation = validateLoftSubmission({ sections: resolvedSections });
    if (!validation.ok) return validation;
    const n = loftCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_loft${suffix}`);
    const featureId = createFeatureId(`feat_loft${suffix}`);
    const stationCommands = sections.map((choice, index) => ({
      type: "parameter.create" as const,
      id: createParameterId(`param_loft_z${suffix}_${String(index)}`),
      name: `loftZ${suffix}_${String(index)}`,
      value: length(choice.stationMm),
    }));
    const committed = documentApi.applyTransaction({
      commands: [
        ...stationCommands,
        { type: "body.create", id: bodyId, name: `lofted ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "loft",
          inputs: sections.flatMap((choice, index) => [
            {
              kind: "sketch" as const,
              id: createSketchDocumentId(choice.sketchId),
            },
            {
              kind: "parameter" as const,
              id: createParameterId(`param_loft_z${suffix}_${String(index)}`),
            },
          ]),
          outputs: [bodyId],
        },
      ],
    });
    if (!committed.ok) {
      return {
        ok: false,
        code: committed.error.code,
        message: committed.error.message,
      };
    }
    setLoftCount(n);
    setActiveScene("loft");
    return { ok: true };
  };

  const timeline: readonly FeatureTimelineEntry[] | null = useMemo(() => {
    if (runState === null) return null;
    // The worker's verdict outranks the document-data executor's "valid"
    // for the ONE feature whose build the kernel refused — a refusal the
    // error surface carries must not read "valid" on the chip.
    const states =
      sceneFeatureFailure === null
        ? runState.states
        : sceneVerdictAdjustedStates(
            runState.states,
            workbenchDocument,
            sceneFeatureFailure,
          );
    const joined = featureTimeline({
      features: workbenchDocument.features,
      states,
      rollback,
      suppressed: [...suppressed],
    });
    return joined.ok ? joined.value : null;
  }, [workbenchDocument, runState, rollback, suppressed, sceneFeatureFailure]);

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
      { backend, onSceneOutcome },
    );
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
    // arm and beginRegeneration are stable store operation identities and
    // onSceneOutcome is a stable callback: the session boots exactly once
    // (the backend id is boot-time configuration, not a live switch —
    // remount the host to change it).
  }, [
    arm,
    beginRegeneration,
    rootId,
    statusId,
    volumeId,
    errorId,
    backend,
    onSceneOutcome,
  ]);

  // The scene dispatch: whichever computation the active scene names follows
  // the DOCUMENT (the parameter edit → regenerate criterion) — the plate
  // scene follows the hole diameter, the extrude scene re-reads the
  // document's extrude feature through the profile resolver (a datum-
  // anchored pad dispatches the COMPOSED pad scene: base + pad union, so a
  // driving-face edit is measurable in the settle volume), the hole scene
  // re-reads the hole composition (base extrusion + every hole's five
  // parameters). Declared AFTER the boot effect above so the mount pass
  // runs with the session already in sessionRef — the initial plate
  // dispatch fires, and later action re-triggers (extrudeCount, revolveCount,
  // holeCount) re-dispatch the current scene.
  useEffect(() => {
    if (activeScene === "extrude") {
      const padRequest = documentPadSceneRequest(workbenchDocument);
      if (padRequest !== null) {
        sessionRef.current?.dispatchPad(padRequest, padRequest.bodyId);
        return;
      }
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
    if (activeScene === "sweep") {
      const request: SweepSceneRequest | null =
        documentSweepRequest(workbenchDocument);
      if (request !== null) {
        sessionRef.current?.dispatchSweep(request, request.bodyId);
      }
      return;
    }
    if (activeScene === "loft") {
      const request: LoftSceneRequest | null =
        documentLoftRequest(workbenchDocument);
      if (request !== null) {
        sessionRef.current?.dispatchLoft(request, request.bodyId);
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
    sweepCount,
    loftCount,
    holeCount,
  ]);

  // The host pushes the CURRENT projection into the store — the projection
  // access the active tool reads. Host-side state push, not mirrored state.
  useEffect(() => {
    store.setProjection(applied === null ? null : applied.state.projection);
  }, [applied, store]);

  // The live anchor-projection frame: the viewport canvas's CSS size, read
  // at projection time through a ResizeObserver so the face anchors track
  // the SAME frame the scene camera renders into (R3F consumes the live
  // canvas aspect; projecting into the fixed 800×520 spec frame would
  // mis-place every anchor at any other window size). Kept `null` until a
  // real (non-collapsed) size is observed — a hidden workspace renders the
  // canvas at 0×0, and the last real size must survive that. Hosts without
  // a `viewportId` (the fixed 800×520 workbenches) never measure: the
  // authored frame IS their canvas size.
  const [anchorViewport, setAnchorViewport] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  const projectionLive = applied !== null;
  useEffect(() => {
    if (viewportId === undefined || typeof ResizeObserver === "undefined") {
      return;
    }
    // The canvas mounts with the first applied projection (the viewport
    // renders its scene only then), so the lookup re-runs when that lands.
    const canvas = document.querySelector(`#${viewportId} canvas`);
    if (!(canvas instanceof HTMLElement)) return;
    const observer = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = canvas;
      if (clientWidth > 0 && clientHeight > 0) {
        setAnchorViewport({ width: clientWidth, height: clientHeight });
      }
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
    };
  }, [viewportId, projectionLive]);

  const faceAnchors = useMemo(
    () =>
      applied === null
        ? ""
        : faceAnchorSurface(applied.state, anchorViewport ?? undefined),
    [applied, anchorViewport],
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
    tightBooleanBounds: sessionBackendOf(backend).tightBooleanBounds,
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

  // The Phase 39 datum creation action (the Formedible form's submission
  // seam): validates the payload through the datum module's parser, then
  // commits the datum.create command in one atomic transaction. A refusal
  // commits nothing and hands the structured outcome back to the form.
  const handleCreateDatum = (
    payload: Record<string, unknown>,
  ): FeatureFormOutcome => {
    const parsed = parseDatumPayload(payload);
    if (!parsed.ok) {
      return {
        ok: false,
        code: parsed.error.code,
        message: parsed.error.message,
      };
    }
    const n = datumCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const commit = documentApi.applyTransaction({
      commands: [
        {
          type: "datum.create",
          id: createDatumId(`dtm_datum${suffix}`),
          name: `datum ${String(n)}`,
          datum: payload,
        },
      ],
    });
    if (!commit.ok) {
      return {
        ok: false,
        code: commit.error.code,
        message: commit.error.message,
      };
    }
    setDatumCount(n);
    return { ok: true };
  };

  // The datums machine surface: every datum record with its kind and, for
  // PLANE datums, the session-resolved plane (or the structured failure),
  // canonical JSON. A plane datum whose resolution fails surfaces its
  // failure code — the surface tells the truth about unanchored datums
  // instead of hiding them. A NON-plane datum (axis, point, cSys) reports
  // `resolved: null` with its kind: this surface resolves PLANES, and a
  // healthy axis datum is not a failed plane resolution.
  const datumsJson = useMemo(() => {
    const resolved = workbenchDocument.datums.map((datum) => {
      const payload = parseDatumPayload(datum.datum);
      const kind = payload.ok ? payload.value.datumType : null;
      if (kind !== null && kind !== "plane") {
        return {
          id: datum.id,
          kind,
          name: datum.name,
          resolved: null,
        };
      }
      const plane = resolveSessionDatumPlane(workbenchDocument, datum.id);
      return plane.ok
        ? {
            id: datum.id,
            kind: "plane" as const,
            name: datum.name,
            resolved: true,
            origin: plane.origin,
            normal: plane.normal,
          }
        : {
            id: datum.id,
            kind: "plane" as const,
            name: datum.name,
            resolved: false,
            code: plane.error.code,
          };
    });
    return JSON.stringify(resolved);
  }, [workbenchDocument]);

  // Exiting to the model workspace drops the sketch anchor: an anchor
  // without a sketch session behind it would silently attach the NEXT
  // sketch's extrude to a face the user picked minutes ago.
  const wrappedSetMode = (next: WorkbenchMode): void => {
    if (next === "model") setSketchAnchor(null);
    setMode(next);
  };

  return {
    mode,
    setMode: wrappedSetMode,
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
    handleSaveSketch,
    handleSweep,
    handleLoft,
    handleSketchOnFace,
    sketchBootWorkplane: sketchAnchor === null ? null : sketchAnchor.workplane,
    datumsJson,
    handleCreateDatum,
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
