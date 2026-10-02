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
  type BodyId,
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
  applyDocumentConfiguration,
  createBodyId,
  createCurveId,
  createDatumId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  equalQuantity,
  length,
  overridesFromCsvRows,
  parseDatumPayload,
  parseParameterId,
  parseParameterTableCsv,
  serializeParameterTableCsv,
  type AnyDimensionalValue,
  type CadCommand,
  type ConfigurationId,
  type DatumId,
  type Parameter,
  type ParameterId,
  appearanceLibraryEntry,
} from "@slopcad/cad-core";
import type { KernelResolvedProfile } from "@slopcad/cad-kernel";
import { structuredHoleRoles, structuredHoleTypeOf } from "@slopcad/cad-kernel";
import type { Workplane } from "@slopcad/cad-sketch";
import type { SectionDisplayRequest } from "../render-fixture/plate-render-scene";

import {
  bootRenderFixtureSession,
  faceAnchorSurface,
  type FixtureRenderState,
  type RenderFixtureSession,
  type SceneDispatchOutcome,
} from "../render-fixture/fixture-session";
import { documentSceneBodies, renderableBodyIds } from "./document-scene";
import { holeDiameterMm } from "../workbench-fixture/workbench-document";
import { workbenchExecutor } from "../workbench-fixture/workbench-extended-document";
import { createCadWorkbenchSession } from "./session";
import {
  computedFacePickOrdinal,
  hasComputedAnchoredExtrude,
  sceneOperandOfBody,
  sessionComputedFacesOf,
  sketchIdsBoundToParameters,
  sketchProfileResolverOf,
  type SessionComputedFaces,
} from "./extrude";
import {
  defaultHolePosition,
  holeBaseFeatureOf,
  HOLE_DEFAULT_AXIS,
  HOLE_DEFAULT_DEPTH_MM,
  HOLE_DEFAULT_DIAMETER_MM,
  sketchPointsResolverOf,
} from "./hole";
import {
  STRUCTURED_HOLE_DEFAULTS,
  validateStructuredHoleSubmission,
  type StructuredHoleSubmission,
} from "./hole-dialog";
import { type SketchRevolveSubmission } from "./revolve";
import { sketchPathResolverOf, validateSweepSubmission } from "./sweep";
import { validateLoftSubmission, type LoftSectionChoice } from "./loft";
import {
  EXTRUDE_DEFAULT_DEPTH_MM,
  type SketchExtrudeSubmission,
} from "./SketchMode";
import {
  resolveSessionDatumPlane,
  sceneFacePickOfSelection,
  sessionFaceReferenceOf,
  resolveSessionDatumAxis,
  type SceneFacePick,
} from "./datum";
import { boundsReadout } from "./bounds-inspection";
import { distanceReadout } from "./distance-inspection";
import { massPropertiesReadout } from "./mass-properties-inspection";
import { sectionInspectionReadout } from "./section-inspection";
import { radiusReadout } from "./radius-inspection";
import { clampedRollbackMarker, rollbackMarkerKey } from "./rollback-marker";
import { helixSpineOf, validateHelixSubmission } from "./helix";
import {
  threadTargetFeatureOf,
  validateThreadLength,
  validateThreadSelectors,
  type ThreadCutInputRef,
} from "./thread";
import { ribTargetFeatureOf, validateRibSubmission } from "./rib";
import {
  richnessTargetFeatureOf,
  validateScaleSubmission,
  validateSplitSubmission,
  validateThickenSubmission,
  type ScaleInputRef,
  type ThickenInputRef,
} from "./scale-thicken";
import {
  featureSlotCreateCommand,
  featureSlotInputId,
  negatedReferenceCreateCommand,
  resolveFeatureNumberValue,
  type FeatureNumberValue,
  type FeatureValueSlot,
} from "./parameter-reference";
import {
  patternTargetFeatureOf,
  validateMirrorSubmission,
  validatePatternPathSubmission,
  validatePatternSubmission,
} from "./pattern";
import {
  featureProducingBody,
  validateBooleanSubmission,
  type BooleanOperation,
} from "./boolean";
import {
  moveBodyTargetFeatureOf,
  validateMoveBodySubmission,
} from "./move-body";
import { validateBodyRenameSubmission } from "./body-management";
import {
  curvePayloadOf,
  curveSceneSegments,
  type CurveAuthoring,
} from "./curves";
import {
  sessionBackendOf,
  type FixtureSessionBackendId,
} from "../render-fixture/session-backend";

/** The workbench's top-level modes: the 3D model workspace or the sketch. */
export type WorkbenchMode = "model" | "sketch";

/** An applied computation: the render state plus its revision identity. */
interface AppliedRenderState {
  readonly state: FixtureRenderState;
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
 * document names (Phase 38 adds the sweep and loft scenes; Phase 43 adds
 * the pattern and mirror scenes). Phase 47 adds the `curves` scene: a
 * curve-record authoring surface whose dispatch re-drives the highest
 * solid scene the document still resolves beneath the curve overlay (the
 * plate when there is none) — creating a curve never blanks the solids.
 */
export type WorkbenchSceneKind =
  | "plate"
  | "extrude"
  | "revolve"
  | "sweep"
  | "loft"
  | "helix"
  | "thread"
  | "boolean"
  | "moveBody"
  | "rib"
  | "scale"
  | "thicken"
  | "split"
  | "patternFeature"
  | "patternPath"
  | "mirror"
  | "hole"
  | "curves"
  | "sheet";

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
  /** The Phase 46 section display state and its readout (see the module docs). */
  readonly sectionClipped: boolean;
  readonly sectionViewMode: boolean;
  readonly toggleSectionClipped: () => void;
  readonly toggleSectionViewMode: () => void;
  readonly sectionState: ReturnType<typeof sectionInspectionReadout>;
  /** The machine timeline JSON (rollback, entries, executed). */
  readonly timelineJson: string;
  /** The configurations machine surface (rows, deltas, active id), canonical JSON. */
  readonly configurationsJson: string;
  /** The active configuration row's id, or `null` for the base document. */
  readonly activeConfigurationId: ConfigurationId | null;
  /** The last configuration action's structured refusal, surfaced verbatim. */
  readonly configurationNotice: string | null;
  /** Applies a configuration row (`null` returns to the base document). */
  readonly applyConfiguration: (
    configurationId: ConfigurationId | null,
  ) => void;
  /** Creates a row capturing the current parameter values as overrides. */
  readonly createConfiguration: (name: string) => void;
  /** Deletes a configuration row by id. */
  readonly deleteConfiguration: (configurationId: ConfigurationId) => void;
  /** The deterministic parameter-table CSV of the current document. */
  readonly exportParameterTableCsv: () => string;
  /** Imports CSV text as parameter-table edits (one transaction). */
  readonly importParameterTableCsv: (text: string) => void;
  /** The extrude create action (the sketch → solid UX bridge). */
  readonly handleExtrude: (submission: SketchExtrudeSubmission) => void;
  /** The revolve create action (the sketch → solid UX bridge). */
  readonly handleRevolve: (submission: SketchRevolveSubmission) => void;
  /** The hole create action (parameter-panel-driven defaults). */
  readonly handleHole: () => void;
  /**
   * The Phase 42 structured hole create action (the hole dialog's engine
   * side): validates the submission (the shared authoring battery), then
   * commits the type-directed parameter list, the output body, and the
   * `hole` feature — with a positions sketch and/or a datum axis input —
   * in ONE atomic transaction. A refusal commits nothing and surfaces
   * verbatim in the dialog's error region.
   */
  readonly handleStructuredHole: (
    submission: StructuredHoleSubmission,
  ) => FeatureFormOutcome;
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
   * The Phase 49 surface tab's authoring actions: each commits its
   * parameters, the output body, and the bridge surface feature kind in
   * one atomic transaction (the loft action's pattern). A refusal commits
   * nothing and returns the structured outcome for the form.
   */
  readonly handleCreateSheet: (submission: {
    readonly datumId: DatumId;
    readonly uMinMm: FeatureNumberValue;
    readonly uMaxMm: FeatureNumberValue;
    readonly vMinMm: FeatureNumberValue;
    readonly vMaxMm: FeatureNumberValue;
  }) => FeatureFormOutcome;
  readonly handleTrimSurface: (submission: {
    readonly sheetId: BodyId;
    readonly toolId: BodyId;
    readonly keepInside: 0 | 1;
  }) => FeatureFormOutcome;
  readonly handleThickenSurface: (submission: {
    readonly sheetId: BodyId;
    readonly thicknessMm: FeatureNumberValue;
    readonly side: 1 | -1;
  }) => FeatureFormOutcome;
  readonly handleKnitSurface: (submission: {
    readonly sheetIds: readonly BodyId[];
    readonly toleranceMm: FeatureNumberValue;
  }) => FeatureFormOutcome;
  readonly handleOffsetSurface: (submission: {
    readonly sheetId: BodyId;
    readonly distanceMm: FeatureNumberValue;
  }) => FeatureFormOutcome;
  /**
   * The Phase 40 helix create action: validates the picked meridian sketch
   * and spine numbers through the action-time battery, then commits the
   * spine parameters and the helix feature in one atomic transaction and
   * switches the scene. A refusal commits nothing and returns the
   * structured outcome for the form.
   */
  readonly handleHelix: (
    sketchId: string,
    authoring: {
      readonly radiusMm: FeatureNumberValue;
      readonly pitchMm: FeatureNumberValue;
      readonly turns: FeatureNumberValue;
      readonly handedness: 1 | -1;
      readonly startAngleRad: FeatureNumberValue;
      readonly taperMm: FeatureNumberValue;
    },
    datumAxisId: string | null,
  ) => FeatureFormOutcome;
  /**
   * The Phase 40 thread create action: validates the ISO specification
   * numbers, then commits the thread parameters and the thread feature
   * (targeting the document's last extrude) in one atomic transaction.
   * A refusal commits nothing and returns the structured outcome.
   */
  readonly handleThread: (
    specification: ThreadCutInputRef,
  ) => FeatureFormOutcome;
  /**
   * The Phase 41 draft-extrude create action: validates the numbers,
   * resolves the picked sketch through the profile seam, then commits the
   * distance and taper parameters and the THREE-INPUT extrude feature in
   * one atomic transaction. A refusal commits nothing.
   */
  readonly handleDraft: (specification: {
    readonly sketchId: string;
    readonly distanceMm: FeatureNumberValue;
    readonly taperDeg: FeatureNumberValue;
  }) => FeatureFormOutcome;
  /**
   * The Phase 41 rib create action: validates the thickness, then commits
   * the rib parameter and the rib feature (the picked cross-section sketch,
   * targeting the document's last extrude) in one atomic transaction. A
   * refusal commits nothing.
   */
  readonly handleRib: (specification: {
    readonly sketchId: string;
    readonly thicknessMm: FeatureNumberValue;
  }) => FeatureFormOutcome;
  /**
   * The Phase 41 scale create action: validates the factor, then commits
   * the scale parameter and the scale feature (targeting the document's
   * last extrude) in one atomic transaction. A refusal commits nothing.
   */
  readonly handleScale: (specification: ScaleInputRef) => FeatureFormOutcome;
  /**
   * The Phase 41 thicken create action: validates the wall thickness,
   * then commits the thicken parameter and the thicken feature (targeting
   * the document's last extrude) in one atomic transaction. A refusal
   * commits nothing.
   */
  readonly handleThicken: (
    specification: ThickenInputRef,
  ) => FeatureFormOutcome;
  /**
   * The Phase 41 split create action: commits the side parameter and the
   * split feature (the picked datum plane, targeting the document's last
   * extrude) in one atomic transaction. A refusal commits nothing.
   */
  readonly handleSplit: (specification: {
    readonly datumPlaneId: string;
    readonly side: 1 | -1;
  }) => FeatureFormOutcome;
  /**
   * The Phase 43 pattern create action (the pattern editor's submission
   * seam): validates the legs and skip list through the action-time
   * battery, then commits each leg's three parameters, each skip's
   * ordinal parameter, and the patternFeature feature (targeting the
   * document's last extrude) in one atomic transaction. A refusal
   * commits nothing.
   */
  readonly handlePattern: (specification: {
    readonly legs: readonly {
      readonly directionDeg: number;
      readonly count: number;
      readonly spacingMm: number;
    }[];
    readonly skips: readonly number[];
  }) => FeatureFormOutcome;
  /**
   * The Phase 43 path-pattern create action: validates the numbers and
   * resolves the picked path sketch through the same path seam the
   * executor bridge rides, then commits the count/spacing/orientation
   * parameters and the patternPath feature in one atomic transaction. A
   * refusal commits nothing.
   */
  readonly handlePatternPath: (specification: {
    readonly sketchId: string;
    readonly count: number;
    readonly spacingMm: number;
    readonly orientation: number;
  }) => FeatureFormOutcome;
  /**
   * The Phase 43 mirror create action: validates the merge option, then
   * commits the merge parameter and the mirror feature (the picked datum
   * plane, targeting the document's last extrude) in one atomic
   * transaction. A refusal commits nothing.
   */
  readonly handleMirror: (specification: {
    readonly datumPlaneId: string;
    readonly merge: number;
  }) => FeatureFormOutcome;
  /**
   * The Phase 44 boolean create action: commits the boolean feature (the
   * EXISTING union/subtract/intersect bridge kind over the operands'
   * producing features) — and, when the tools are consumed, the tool
   * bodies' visibility flags — in one atomic transaction. A refusal
   * commits nothing.
   */
  readonly handleBoolean: (specification: {
    readonly operation: BooleanOperation;
    readonly targetBodyId: string;
    readonly toolBodyIds: readonly string[];
    readonly keepToolBodies: boolean;
  }) => FeatureFormOutcome;
  /**
   * The Phase 44 move-body create action: commits the translate
   * parameters and the translate feature (the existing kind, grown with
   * the optional rotation pair) targeting the document's last extrude in
   * one atomic transaction. A refusal commits nothing.
   */
  readonly handleMoveBody: (specification: {
    readonly offsetMm: readonly [number, number, number];
    readonly rotation: {
      readonly axis: 1 | 2 | 3;
      readonly angleDeg: number;
    } | null;
  }) => FeatureFormOutcome;
  /**
   * The Phase 44 body-management actions: rename, visibility, and
   * isolation — each one `body.update` command in its own transaction.
   */
  readonly handleBodyRename: (
    bodyId: string,
    name: string,
  ) => FeatureFormOutcome;
  readonly handleBodyAppearance: (
    bodyId: string,
    presetId: string | null,
  ) => FeatureFormOutcome;
  readonly handleBodyVisibility: (
    bodyId: string,
    visible: boolean,
  ) => FeatureFormOutcome;
  readonly handleBodyIsolate: (
    bodyId: string,
    isolated: boolean,
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
  /**
   * The Phase 47 curve creation action (the Formedible form's submission
   * seam): builds the payload through the curve module's authoring
   * validators, then commits the curve.create command and switches the
   * scene to the curves surface. A refusal commits nothing.
   */
  readonly handleCreateCurve: (authoring: CurveAuthoring) => FeatureFormOutcome;
  /**
   * The document's curve records with their kind and deterministic scene
   * segment count, as canonical JSON for the machine surface (empty array
   * when none).
   */
  readonly curvesJson: string;
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
  const [surfaceCount, setSurfaceCount] = useState(0);
  const [helixCount, setHelixCount] = useState(0);
  const [threadCount, setThreadCount] = useState(0);
  const [ribCount, setRibCount] = useState(0);
  const [scaleCount, setScaleCount] = useState(0);
  const [thickenCount, setThickenCount] = useState(0);
  const [splitCount, setSplitCount] = useState(0);
  const [patternCount, setPatternCount] = useState(0);
  const [patternPathCount, setPatternPathCount] = useState(0);
  const [mirrorCount, setMirrorCount] = useState(0);
  const [booleanCount, setBooleanCount] = useState(0);
  const [moveBodyCount, setMoveBodyCount] = useState(0);
  // The Phase 39 sketch-on-face anchor: the datum record the CURRENT sketch
  // session boots on (its id commits with the extrude feature; its plane
  // booted the sketch editor). `null` in the ordinary sketch flow.
  const [sketchAnchor, setSketchAnchor] = useState<{
    readonly datumId: DatumId;
    readonly workplane: Workplane;
  } | null>(null);
  const [datumCount, setDatumCount] = useState(0);
  // The Phase 47 curve record creations: the id-minting counter (the datum
  // count's discipline — the n-th curve commits as `crv_curve{n}`).
  const [curveCount, setCurveCount] = useState(0);

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

  // The computed-face source (the sketch-on-face fix for computed bodies):
  // the settled scene's analytic face planes for every COMPUTED-classified
  // body — a boolean cavity floor, a holed face, a pad face, a moved body —
  // derived from the SAME projection the picker addresses, so a datum
  // recorded at pick time re-resolves against the face the scene settled.
  // `null` before the first settle (computed references refuse — the
  // honest absence; plain-extrude datums resolve from the document as
  // always). One worker dispatch produced the projection; the derivation
  // is cached per settle (the memo) and the dispatch effect reads it
  // through `computedFacesRef` so a settle re-triggers the scene pass only
  // when a computed-anchored datum's planes actually moved (the digest).
  const computedFaces = useMemo(
    () =>
      sessionComputedFacesOf(
        workbenchDocument,
        applied === null ? null : applied.state.projection,
      ),
    [workbenchDocument, applied],
  );
  const computedFacesRef = useRef<SessionComputedFaces | null>(null);
  const datumFollowDigest = useMemo(
    () =>
      hasComputedAnchoredExtrude(workbenchDocument)
        ? (computedFaces?.digest ?? "")
        : "",
    [workbenchDocument, computedFaces],
  );

  // The Phase 46 section display: the document's FIRST section record is
  // the persisted model artifact (its plane and kept side serialize with
  // the document); the CLIP and VIEW toggles are session display state,
  // seeded from the record's enabled flag — off at boot, so the unsectioned
  // settle and its raster are byte-unchanged (the boot-state law).
  const documentSection = workbenchDocument.sections[0] ?? null;
  const [sectionClipped, setSectionClipped] = useState(
    documentSection?.enabled === true,
  );
  const [sectionViewMode, setSectionViewMode] = useState(false);
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
    // The parameter-bound-sketch edge: a feature consumes its sketch
    // record, not the sketch's bindings, so the graph cannot see a changed
    // parameter through it. Expand the changed-node set with every sketch
    // bound to a changed parameter — the existing sketch→feature edges
    // then invalidate exactly the consuming features, and the next
    // regenerate re-executes them against the new parameter values.
    const changedParameterIds = new Set(
      changedNodes.flatMap((node) => {
        const parsed = parseParameterId(node);
        return parsed.ok ? [parsed.value] : [];
      }),
    );
    const boundSketchIds = sketchIdsBoundToParameters(
      workbenchDocument,
      changedParameterIds,
    );
    const states =
      previous === null
        ? initialRegenerationStates(features)
        : markStale(features, previous.states, [
            ...changedNodes,
            ...boundSketchIds,
          ]);
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
  // plane. A face picked on a COMPUTED body (boolean cavity floor, holed
  // face, pad face, moved body) records the same-normal ordinal and
  // resolves through the settled scene's computed-face source (./extrude's
  // `sessionComputedFacesOf`) — the same planes the pick addressed.
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
    const pickedReference = sessionFaceReferenceOf(pick);
    if (pickedReference === null) {
      return {
        ok: false,
        message: "The picked face cannot anchor a datum plane.",
      };
    }
    // A COMPUTED body's reference records the same-normal ordinal — the
    // key its computed-face resolution re-derives the plane from on every
    // dispatch (the ordinal contract in ./datum). A plain extrusion's
    // reference stays ordinal-free; its caps resolution keys on the
    // normal alone, exactly as it always has.
    const faceOrdinal = computedFacePickOrdinal(
      workbenchDocument,
      applied.state.projection,
      reference,
    );
    const referencePayload =
      faceOrdinal === null
        ? pickedReference
        : { ...pickedReference, faceOrdinal };
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
    // scene request re-derives on every dispatch. The settled scene's
    // computed-face source rides along so a COMPUTED body's face resolves
    // here (the pick came from that same scene — the frames agree).
    const plane = resolveSessionDatumPlane(
      commit.value.document,
      datumId,
      computedFaces ?? undefined,
    );
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
    if (holeBase === undefined) return;
    // The default position centers the TARGET body's rendered bounds — the
    // applied scene is the full document (Phase 16), so the aggregate
    // bounds can center on material the hole does not cut. The base
    // body's own render object carries the exact world AABB.
    const baseBodyId = holeBase.outputs[0];
    const baseObject =
      applied === null || baseBodyId === undefined
        ? undefined
        : applied.state.projection.objects.find(
            (object) => object.bodyId === baseBodyId,
          );
    const bounds = baseObject?.bounds ?? applied?.state.measurement.bounds;
    if (bounds === undefined) return;
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

  // The Phase 42 structured hole action (the hole dialog's engine side):
  // validate the submission (the shared authoring battery — one source with
  // the kernel's own structural checks), resolve the picked positions
  // sketch's POINT entities and the datum axis through the session seams
  // BEFORE anything commits, then commit the type-directed parameter list
  // (the kernel's `structuredHoleRoles` schema, in declared order), the
  // output body, and the `hole` feature in ONE atomic transaction. A
  // refusal commits nothing and surfaces verbatim in the dialog's error
  // region; the target-relative verdicts (tip fit, the no-op miss) are the
  // dispatch's own structured failures, never the form's guesses.
  const [structuredHoleCount, setStructuredHoleCount] = useState(0);
  const handleStructuredHole = (
    submission: StructuredHoleSubmission,
  ): FeatureFormOutcome => {
    const target = holeBaseFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A hole needs a target solid: extrude a profile first (the hole cuts the last extrusion).",
      };
    }
    const validation = validateStructuredHoleSubmission(submission);
    if (!validation.ok) return validation;
    const type = structuredHoleTypeOf(submission.spec.type);
    if (type === null) {
      return {
        ok: false,
        code: "kernel/parameter-invalid",
        message: "The hole type selector must be 1–5.",
      };
    }
    // The positions sketch must exist and carry at least one point — the
    // resolver failure verbatim, before any commit.
    if (submission.positionsSketchId !== null) {
      const resolved = sketchPointsResolverOf(workbenchDocument)(
        submission.positionsSketchId,
      );
      if (!resolved.ok) {
        return {
          ok: false,
          code: resolved.code,
          message: resolved.message,
        };
      }
      if (resolved.points.length === 0) {
        return {
          ok: false,
          code: "kernel/feature-input-invalid",
          message:
            "The positions sketch carries no point entities; draw the hole centres as points (one feature, many holes) or use the parameter position.",
        };
      }
    }
    // The datum axis must resolve in-session (the thread reader's
    // discipline — never a silent world-axis fallback).
    if (submission.datumAxisId !== null) {
      const resolved = resolveSessionDatumAxis(
        workbenchDocument,
        submission.datumAxisId,
      );
      if (!resolved.ok) {
        return {
          ok: false,
          code: resolved.error.code,
          message: resolved.error.message,
        };
      }
    }
    const roles = structuredHoleRoles(type, {
      sketchPositions: submission.positionsSketchId !== null,
      datumAxis: submission.datumAxisId !== null,
    });
    const spec = { ...STRUCTURED_HOLE_DEFAULTS.spec, ...submission.spec };
    // The Phase 21 references: each named role resolves against the
    // document's parameters — the kernel's own role kind is the demanded
    // dimension (one source, never a hand-maintained table). The reference
    // carries NO literal; the role commits no parameter.create and its
    // feature input points at the existing parameter id. A NEGATED token
    // (Phase 30) resolves the same parameter and rides the negated
    // auto-parameter route: the role's fresh parameter is created with the
    // `-name` expression and the input points at IT.
    const parameterRefs = submission.parameterRefs ?? {};
    const referenceOf = new Map<string, Parameter>();
    const negatedOf = new Map<string, Parameter>();
    for (const role of roles) {
      const ref = parameterRefs[role.name];
      if (ref === undefined) continue;
      const resolved = resolveFeatureNumberValue(
        ref,
        workbenchDocument.parameters,
        { dimension: role.kind, label: `The hole's ${role.name}` },
      );
      if (!resolved.ok) return resolved;
      if (resolved.kind === "reference") {
        referenceOf.set(role.name, resolved.parameter);
      } else if (resolved.kind === "negatedReference") {
        negatedOf.set(role.name, resolved.parameter);
      }
    }
    const roleValueOf = (
      role: string,
    ):
      | ReturnType<typeof length>
      | ReturnType<typeof angle>
      | ReturnType<typeof dimensionless> => {
      switch (role) {
        case "type":
          return dimensionless(spec.type);
        case "diameter":
          return length(spec.diameterMm);
        case "depth":
          return length(spec.depthMm);
        case "tipAngle":
          return angle((spec.tipAngleDeg * Math.PI) / 180);
        case "cboreDiameter":
          return length(spec.cboreDiameterMm);
        case "cboreDepth":
          return length(spec.cboreDepthMm);
        case "csinkDiameter":
          return length(spec.csinkDiameterMm);
        case "csinkAngle":
          return angle((spec.csinkAngleDeg * Math.PI) / 180);
        case "taperAngle":
          return angle((spec.taperAngleDeg * Math.PI) / 180);
        case "threadMajor":
          return length(spec.threadMajorMm);
        case "threadPitch":
          return length(spec.threadPitchMm);
        case "positionX":
          return length(submission.positionXMm);
        case "positionY":
          return length(submission.positionYMm);
        case "axis":
          return dimensionless(submission.axis);
        default:
          throw new Error(`unknown structured hole role ${role}`);
      }
    };
    const n = structuredHoleCount + 1;
    const suffix = String(n);
    const roleIds = roles.map((role) =>
      createParameterId(`param_shole_${role.name}${suffix}`),
    );
    const bodyId = createBodyId(`body_shole${suffix}`);
    const featureId = createFeatureId(`feat_shole${suffix}`);
    const roleCommands: CadCommand[] = [];
    const roleInputIds: ParameterId[] = [];
    roles.forEach((role, index) => {
      const id = roleIds[index];
      if (id === undefined) throw new Error("the role id list");
      const reference = referenceOf.get(role.name);
      if (reference !== undefined) {
        roleInputIds.push(reference.id);
        return;
      }
      const negated = negatedOf.get(role.name);
      if (negated !== undefined) {
        // The negated route: the role's own parameter is created with the
        // `-name` expression (the seed is the negated cache), so the sign
        // survives in the DAG and the input references THIS id.
        roleCommands.push(
          negatedReferenceCreateCommand(
            negated,
            id,
            `hole${role.name.charAt(0).toUpperCase()}${role.name.slice(1)}${suffix}`,
          ),
        );
        roleInputIds.push(id);
        return;
      }
      roleCommands.push({
        type: "parameter.create",
        id,
        name: `hole${role.name.charAt(0).toUpperCase()}${role.name.slice(1)}${suffix}`,
        value: roleValueOf(role.name),
      });
      roleInputIds.push(id);
    });
    const committed = documentApi.applyTransaction({
      commands: [
        ...roleCommands,
        {
          type: "body.create" as const,
          id: bodyId,
          name: `holed ${String(n)}`,
        },
        {
          type: "feature.create" as const,
          id: featureId,
          kind: "hole",
          inputs: [
            { kind: "feature", id: target.id },
            ...roleInputIds.map((id) => ({ kind: "parameter" as const, id })),
            ...(submission.positionsSketchId !== null
              ? [
                  {
                    kind: "sketch" as const,
                    id: createSketchDocumentId(submission.positionsSketchId),
                  },
                ]
              : []),
            ...(submission.datumAxisId !== null
              ? [
                  {
                    kind: "datum" as const,
                    id: createDatumId(submission.datumAxisId),
                  },
                ]
              : []),
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
    setStructuredHoleCount(n);
    setActiveScene("hole");
    return { ok: true };
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

  // The Phase 49 surface actions: the surface tab's authoring tier. Each
  // commits its parameters, the SHEET output body (the `body.create`
  // command's kind marker), and the bridge feature kind in ONE atomic
  // transaction — the loft action's pattern. Kernel execution rides the
  // `create-sheet` / `trim-surface` / `thicken-surface` bridge kinds.
  // Phase 21: the bound values accept `$name` references — the draft
  // action's seam.
  const handleCreateSheet = (submission: {
    readonly datumId: DatumId;
    readonly uMinMm: FeatureNumberValue;
    readonly uMaxMm: FeatureNumberValue;
    readonly vMinMm: FeatureNumberValue;
    readonly vMaxMm: FeatureNumberValue;
  }): FeatureFormOutcome => {
    const uMin = resolveFeatureNumberValue(
      submission.uMinMm,
      workbenchDocument.parameters,
      {
        dimension: "length",
        label: "The u minimum",
      },
    );
    if (!uMin.ok) return uMin;
    const uMax = resolveFeatureNumberValue(
      submission.uMaxMm,
      workbenchDocument.parameters,
      {
        dimension: "length",
        label: "The u maximum",
      },
    );
    if (!uMax.ok) return uMax;
    const vMin = resolveFeatureNumberValue(
      submission.vMinMm,
      workbenchDocument.parameters,
      {
        dimension: "length",
        label: "The v minimum",
      },
    );
    if (!vMin.ok) return vMin;
    const vMax = resolveFeatureNumberValue(
      submission.vMaxMm,
      workbenchDocument.parameters,
      {
        dimension: "length",
        label: "The v maximum",
      },
    );
    if (!vMax.ok) return vMax;
    const n = surfaceCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_surface${suffix}`);
    const featureId = createFeatureId(`feat_surface${suffix}`);
    const kindParam = createParameterId(`param_surface_kind${suffix}`);
    const boundSlots: readonly FeatureValueSlot[] = [
      {
        resolution: uMin,
        literalId: createParameterId(`param_surface_umin${suffix}`),
        literalName: `surfaceUMin${suffix}`,
        toLiteralValue: length,
      },
      {
        resolution: uMax,
        literalId: createParameterId(`param_surface_umax${suffix}`),
        literalName: `surfaceUMax${suffix}`,
        toLiteralValue: length,
      },
      {
        resolution: vMin,
        literalId: createParameterId(`param_surface_vmin${suffix}`),
        literalName: `surfaceVMin${suffix}`,
        toLiteralValue: length,
      },
      {
        resolution: vMax,
        literalId: createParameterId(`param_surface_vmax${suffix}`),
        literalName: `surfaceVMax${suffix}`,
        toLiteralValue: length,
      },
    ];
    const boundCommands = boundSlots
      .map(featureSlotCreateCommand)
      .filter((command) => command !== null);
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "parameter.create" as const,
          id: kindParam,
          name: `surfaceKind${suffix}`,
          value: dimensionless(0),
        },
        ...boundCommands,
        {
          type: "body.create" as const,
          id: bodyId,
          name: `surface ${String(n)}`,
          kind: "sheet" as const,
        },
        {
          type: "feature.create" as const,
          id: featureId,
          kind: "create-sheet",
          inputs: [
            { kind: "datum" as const, id: submission.datumId },
            { kind: "parameter" as const, id: kindParam },
            ...boundSlots.map((slot) => ({
              kind: "parameter" as const,
              id: featureSlotInputId(slot),
            })),
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
    setSurfaceCount(n);
    setActiveScene("sheet");
    return { ok: true };
  };

  const handleTrimSurface = (submission: {
    readonly sheetId: BodyId;
    readonly toolId: BodyId;
    readonly keepInside: 0 | 1;
  }): FeatureFormOutcome => {
    const n = surfaceCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_surface${suffix}`);
    const featureId = createFeatureId(`feat_surface_trim${suffix}`);
    const keepParam = createParameterId(`param_surface_keep${suffix}`);
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "parameter.create" as const,
          id: keepParam,
          name: `surfaceKeep${suffix}`,
          value: dimensionless(submission.keepInside),
        },
        {
          type: "body.create" as const,
          id: bodyId,
          name: `trimmed ${String(n)}`,
          kind: "sheet" as const,
        },
        {
          type: "feature.create" as const,
          id: featureId,
          kind: "trim-surface",
          inputs: [
            { kind: "body" as const, id: submission.sheetId },
            { kind: "body" as const, id: submission.toolId },
            { kind: "parameter" as const, id: keepParam },
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
    setSurfaceCount(n);
    setActiveScene("sheet");
    return { ok: true };
  };

  const handleThickenSurface = (submission: {
    readonly sheetId: BodyId;
    readonly thicknessMm: FeatureNumberValue;
    readonly side: 1 | -1;
  }): FeatureFormOutcome => {
    const thickness = resolveFeatureNumberValue(
      submission.thicknessMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The surface wall thickness" },
    );
    if (!thickness.ok) return thickness;
    const n = surfaceCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_surface_solid${suffix}`);
    const featureId = createFeatureId(`feat_surface_thicken${suffix}`);
    const thicknessSlot: FeatureValueSlot = {
      resolution: thickness,
      literalId: createParameterId(`param_surface_t${suffix}`),
      literalName: `surfaceThickness${suffix}`,
      toLiteralValue: length,
    };
    const thicknessCommand = featureSlotCreateCommand(thicknessSlot);
    const sideParam = createParameterId(`param_surface_side${suffix}`);
    const committed = documentApi.applyTransaction({
      commands: [
        ...(thicknessCommand === null ? [] : [thicknessCommand]),
        {
          type: "parameter.create" as const,
          id: sideParam,
          name: `surfaceSide${suffix}`,
          value: dimensionless(submission.side),
        },
        {
          type: "body.create" as const,
          id: bodyId,
          name: `thickened ${String(n)}`,
        },
        {
          type: "feature.create" as const,
          id: featureId,
          kind: "thicken-surface",
          inputs: [
            { kind: "body" as const, id: submission.sheetId },
            {
              kind: "parameter" as const,
              id: featureSlotInputId(thicknessSlot),
            },
            { kind: "parameter" as const, id: sideParam },
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
    setSurfaceCount(n);
    setActiveScene("sheet");
    return { ok: true };
  };

  const handleKnitSurface = (submission: {
    readonly sheetIds: readonly BodyId[];
    readonly toleranceMm: FeatureNumberValue;
  }): FeatureFormOutcome => {
    const tolerance = resolveFeatureNumberValue(
      submission.toleranceMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The sewing tolerance" },
    );
    if (!tolerance.ok) return tolerance;
    const n = surfaceCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_surface_knit${suffix}`);
    const featureId = createFeatureId(`feat_surface_knit${suffix}`);
    const toleranceSlot: FeatureValueSlot = {
      resolution: tolerance,
      literalId: createParameterId(`param_surface_tol${suffix}`),
      literalName: `surfaceTolerance${suffix}`,
      toLiteralValue: length,
    };
    const toleranceCommand = featureSlotCreateCommand(toleranceSlot);
    const committed = documentApi.applyTransaction({
      commands: [
        ...(toleranceCommand === null ? [] : [toleranceCommand]),
        {
          type: "body.create" as const,
          id: bodyId,
          name: `knit ${String(n)}`,
          kind: "sheet" as const,
        },
        {
          type: "feature.create" as const,
          id: featureId,
          kind: "knit-surface",
          inputs: [
            ...submission.sheetIds.map((sheetId) => ({
              kind: "body" as const,
              id: sheetId,
            })),
            {
              kind: "parameter" as const,
              id: featureSlotInputId(toleranceSlot),
            },
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
    setSurfaceCount(n);
    setActiveScene("sheet");
    return { ok: true };
  };

  const handleOffsetSurface = (submission: {
    readonly sheetId: BodyId;
    readonly distanceMm: FeatureNumberValue;
  }): FeatureFormOutcome => {
    const distance = resolveFeatureNumberValue(
      submission.distanceMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The offset distance" },
    );
    if (!distance.ok) return distance;
    const n = surfaceCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_surface_offset${suffix}`);
    const featureId = createFeatureId(`feat_surface_offset${suffix}`);
    const distanceSlot: FeatureValueSlot = {
      resolution: distance,
      literalId: createParameterId(`param_surface_dist${suffix}`),
      literalName: `surfaceDistance${suffix}`,
      toLiteralValue: length,
    };
    const distanceCommand = featureSlotCreateCommand(distanceSlot);
    const committed = documentApi.applyTransaction({
      commands: [
        ...(distanceCommand === null ? [] : [distanceCommand]),
        {
          type: "body.create" as const,
          id: bodyId,
          name: `offset ${String(n)}`,
          kind: "sheet" as const,
        },
        {
          type: "feature.create" as const,
          id: featureId,
          kind: "offset-surface",
          inputs: [
            { kind: "body" as const, id: submission.sheetId },
            {
              kind: "parameter" as const,
              id: featureSlotInputId(distanceSlot),
            },
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
    setSurfaceCount(n);
    setActiveScene("sheet");
    return { ok: true };
  };

  // The Phase 40 helix action: resolve the picked meridian sketch through
  // the same profile seam the executor bridge uses, run the kernel's helix
  // battery BEFORE anything commits (the sweep action's validation-seam
  // precedent), then commit the six spine parameters and the helix feature
  // in ONE atomic transaction (with the datum axis input when one was
  // picked). A refusal commits nothing and hands the structured outcome
  // back to the form. Phase 21: each spine value is a literal number
  // (today's behavior) or a `$name` reference — a reference skips its
  // creation and the literal-only spine battery (the referenced parameter's
  // magnitude is the kernel's verdict at regeneration).
  const handleHelix = (
    sketchId: string,
    authoring: {
      readonly radiusMm: FeatureNumberValue;
      readonly pitchMm: FeatureNumberValue;
      readonly turns: FeatureNumberValue;
      readonly handedness: 1 | -1;
      readonly startAngleRad: FeatureNumberValue;
      readonly taperMm: FeatureNumberValue;
    },
    datumAxisId: string | null,
  ): FeatureFormOutcome => {
    const radius = resolveFeatureNumberValue(
      authoring.radiusMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The helix radius" },
    );
    if (!radius.ok) return radius;
    const pitch = resolveFeatureNumberValue(
      authoring.pitchMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The helix pitch" },
    );
    if (!pitch.ok) return pitch;
    const turns = resolveFeatureNumberValue(
      authoring.turns,
      workbenchDocument.parameters,
      { dimension: "dimensionless", label: "The helix turn count" },
    );
    if (!turns.ok) return turns;
    const startAngle = resolveFeatureNumberValue(
      authoring.startAngleRad,
      workbenchDocument.parameters,
      { dimension: "angle", label: "The helix start angle" },
    );
    if (!startAngle.ok) return startAngle;
    const taper = resolveFeatureNumberValue(
      authoring.taperMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The helix taper" },
    );
    if (!taper.ok) return taper;
    const profile = sketchProfileResolverOf(workbenchDocument)(
      createSketchDocumentId(sketchId),
    );
    if (!profile.ok) {
      return {
        ok: false,
        code: profile.error.code,
        message: profile.error.message,
      };
    }
    if (
      radius.kind === "number" &&
      pitch.kind === "number" &&
      turns.kind === "number" &&
      startAngle.kind === "number" &&
      taper.kind === "number"
    ) {
      const spine = helixSpineOf({
        radiusMm: radius.value,
        pitchMm: pitch.value,
        turns: turns.value,
        handedness: authoring.handedness,
        startAngleRad: startAngle.value,
        taperMm: taper.value,
      });
      const validation = validateHelixSubmission({
        loop: profile.value.loop,
        spine,
      });
      if (!validation.ok) return validation;
    }
    const n = helixCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_helix${suffix}`);
    const featureId = createFeatureId(`feat_helix${suffix}`);
    const slots: readonly FeatureValueSlot[] = [
      {
        resolution: radius,
        literalId: createParameterId(`param_helix_radius${suffix}`),
        literalName: `helixRadius${suffix}`,
        toLiteralValue: length,
      },
      {
        resolution: pitch,
        literalId: createParameterId(`param_helix_pitch${suffix}`),
        literalName: `helixPitch${suffix}`,
        toLiteralValue: length,
      },
      {
        resolution: turns,
        literalId: createParameterId(`param_helix_turns${suffix}`),
        literalName: `helixTurns${suffix}`,
        toLiteralValue: dimensionless,
      },
      {
        resolution: {
          ok: true,
          kind: "number",
          value: authoring.handedness,
        },
        literalId: createParameterId(`param_helix_handedness${suffix}`),
        literalName: `helixHandedness${suffix}`,
        toLiteralValue: dimensionless,
      },
      {
        resolution: startAngle,
        literalId: createParameterId(`param_helix_start${suffix}`),
        literalName: `helixStartAngle${suffix}`,
        toLiteralValue: angle,
      },
      {
        resolution: taper,
        literalId: createParameterId(`param_helix_taper${suffix}`),
        literalName: `helixTaper${suffix}`,
        toLiteralValue: length,
      },
    ];
    const committed = documentApi.applyTransaction({
      commands: [
        ...slots
          .map(featureSlotCreateCommand)
          .filter((command) => command !== null),
        { type: "body.create", id: bodyId, name: `helix ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "helix",
          inputs: [
            { kind: "sketch", id: createSketchDocumentId(sketchId) },
            ...slots.map((slot) => ({
              kind: "parameter" as const,
              id: featureSlotInputId(slot),
            })),
            ...(datumAxisId === null
              ? []
              : [{ kind: "datum" as const, id: createDatumId(datumAxisId) }]),
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
    setHelixCount(n);
    setActiveScene("helix");
    return { ok: true };
  };

  // The Phase 40 thread action: validate the ISO specification numbers
  // (the action-time battery), then commit the thread parameters and the
  // thread feature targeting the document's LAST EXTRUDE (the hole
  // precedent) in ONE atomic transaction. A refusal commits nothing.
  // Phase 21: each of the three lengths is a literal number (today's
  // behavior) or a `$name` reference — a reference skips its literal gate
  // and the parameter creation; the selectors are always literals.
  const handleThread = (
    specification: ThreadCutInputRef,
  ): FeatureFormOutcome => {
    const major = resolveFeatureNumberValue(
      specification.majorDiameterMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The thread's major diameter" },
    );
    if (!major.ok) return major;
    const pitch = resolveFeatureNumberValue(
      specification.pitchMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The thread's pitch" },
    );
    if (!pitch.ok) return pitch;
    const threadLength = resolveFeatureNumberValue(
      specification.lengthMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The thread's length" },
    );
    if (!threadLength.ok) return threadLength;
    const target = threadTargetFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A thread needs a target solid: extrude a profile first (the thread cuts the last extrusion, the hole's precedent).",
      };
    }
    if (major.kind === "number") {
      const gate = validateThreadLength("majorDiameterMm", major.value);
      if (!gate.ok) return gate;
    }
    if (pitch.kind === "number") {
      const gate = validateThreadLength("pitchMm", pitch.value);
      if (!gate.ok) return gate;
    }
    if (threadLength.kind === "number") {
      const gate = validateThreadLength("lengthMm", threadLength.value);
      if (!gate.ok) return gate;
    }
    const selectors = validateThreadSelectors(specification);
    if (!selectors.ok) return selectors;
    const n = threadCount + 1;
    const suffix = String(n);
    const bodyId = createBodyId(`body_thread${suffix}`);
    const featureId = createFeatureId(`feat_thread${suffix}`);
    const lengthSlots: readonly FeatureValueSlot[] = [
      {
        resolution: major,
        literalId: createParameterId(`param_thread_major${suffix}`),
        literalName: `threadMajor${suffix}`,
        toLiteralValue: length,
      },
      {
        resolution: pitch,
        literalId: createParameterId(`param_thread_pitch${suffix}`),
        literalName: `threadPitch${suffix}`,
        toLiteralValue: length,
      },
      {
        resolution: threadLength,
        literalId: createParameterId(`param_thread_length${suffix}`),
        literalName: `threadLength${suffix}`,
        toLiteralValue: length,
      },
    ];
    const selectorSlots: readonly FeatureValueSlot[] = [
      {
        resolution: { ok: true, kind: "number", value: specification.mode },
        literalId: createParameterId(`param_thread_mode${suffix}`),
        literalName: `threadMode${suffix}`,
        toLiteralValue: dimensionless,
      },
      {
        resolution: {
          ok: true,
          kind: "number",
          value: specification.handedness,
        },
        literalId: createParameterId(`param_thread_handedness${suffix}`),
        literalName: `threadHandedness${suffix}`,
        toLiteralValue: dimensionless,
      },
      {
        resolution: { ok: true, kind: "number", value: specification.axis },
        literalId: createParameterId(`param_thread_axis${suffix}`),
        literalName: `threadAxis${suffix}`,
        toLiteralValue: dimensionless,
      },
    ];
    const committed = documentApi.applyTransaction({
      commands: [
        ...[...lengthSlots, ...selectorSlots]
          .map(featureSlotCreateCommand)
          .filter((command) => command !== null),
        { type: "body.create", id: bodyId, name: `threaded ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "thread",
          inputs: [
            { kind: "feature", id: target.id },
            ...[...lengthSlots, ...selectorSlots].map((slot) => ({
              kind: "parameter" as const,
              id: featureSlotInputId(slot),
            })),
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
    setThreadCount(n);
    setActiveScene("thread");
    return { ok: true };
  };

  // The Phase 41 draft-extrude action: resolve the picked sketch, commit
  // the distance and taper parameters plus the THREE-INPUT extrude feature
  // in ONE atomic transaction. The kernel's own taper battery (the shared
  // validator) judges the geometry at regeneration; the action-time check
  // covers only the authoring domain (finite numbers, non-zero distance,
  // the ±90° bound). Phase 21: each value is a literal number (today's
  // behavior) or a `$name` reference — the reference skips the parameter
  // creation and the literal-only bounds, and the feature input points at
  // the EXISTING parameter so the regeneration loop re-reads its value. A
  // `-$name` value (Phase 30) rides the negated auto-parameter: the slot's
  // create carries the `-name` expression and the input points at that
  // fresh parameter (the literal-only bounds are reference semantics — the
  // sign choice is the user's).
  const handleDraft = (specification: {
    readonly sketchId: string;
    readonly distanceMm: FeatureNumberValue;
    readonly taperDeg: FeatureNumberValue;
  }): FeatureFormOutcome => {
    const distance = resolveFeatureNumberValue(
      specification.distanceMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The extrusion distance" },
    );
    if (!distance.ok) return distance;
    const taper = resolveFeatureNumberValue(
      specification.taperDeg,
      workbenchDocument.parameters,
      { dimension: "angle", label: "The draft taper" },
    );
    if (!taper.ok) return taper;
    if (
      distance.kind === "number" &&
      (!Number.isFinite(distance.value) || distance.value === 0)
    ) {
      return {
        ok: false,
        code: "kernel/parameter-invalid",
        message:
          "The extrusion distance must be a finite, non-zero number of millimetres.",
      };
    }
    if (
      taper.kind === "number" &&
      (!Number.isFinite(taper.value) || Math.abs(taper.value) >= 90)
    ) {
      return {
        ok: false,
        code: "kernel/parameter-invalid",
        message:
          "The draft taper must be a finite angle strictly inside ±90 degrees.",
      };
    }
    const profile = sketchProfileResolverOf(workbenchDocument)(
      createSketchDocumentId(specification.sketchId),
    );
    if (!profile.ok) {
      return {
        ok: false,
        code: profile.error.code,
        message: profile.error.message,
      };
    }
    const n = extrudeCount + 1;
    const suffix = String(n);
    const bodyId = createBodyId(`body_extrude${suffix}`);
    const featureId = createFeatureId(`feat_extrude${suffix}`);
    const slots: readonly FeatureValueSlot[] = [
      {
        resolution: distance,
        literalId: createParameterId(`param_extrude_depth${suffix}`),
        literalName: `extrudeDepth${suffix}`,
        toLiteralValue: length,
      },
      {
        resolution: taper,
        literalId: createParameterId(`param_extrude_taper${suffix}`),
        literalName: `extrudeTaper${suffix}`,
        toLiteralValue: (deg) => angle((deg * Math.PI) / 180),
      },
    ];
    const committed = documentApi.applyTransaction({
      commands: [
        ...slots
          .map(featureSlotCreateCommand)
          .filter((command) => command !== null),
        { type: "body.create", id: bodyId, name: `drafted ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "extrude",
          inputs: [
            {
              kind: "sketch",
              id: createSketchDocumentId(specification.sketchId),
            },
            ...slots.map((slot) => ({
              kind: "parameter" as const,
              id: featureSlotInputId(slot),
            })),
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
    setExtrudeCount(n);
    setActiveScene("extrude");
    return { ok: true };
  };

  // The Phase 41 rib action: validate the thickness (the action-time
  // battery), resolve the picked cross-section sketch through the same
  // profile seam the executor bridge uses, then commit the rib parameter
  // and the rib feature targeting the document's LAST EXTRUDE (the thread
  // precedent) in ONE atomic transaction. A refusal commits nothing.
  // Phase 21: a `$name` thickness references the existing parameter (no
  // creation, no literal-only battery) — the draft action's seam.
  const handleRib = (specification: {
    readonly sketchId: string;
    readonly thicknessMm: FeatureNumberValue;
  }): FeatureFormOutcome => {
    const thickness = resolveFeatureNumberValue(
      specification.thicknessMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The rib thickness" },
    );
    if (!thickness.ok) return thickness;
    if (thickness.kind === "number") {
      const validation = validateRibSubmission({
        thicknessMm: thickness.value,
      });
      if (!validation.ok) return validation;
    }
    const target = ribTargetFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A rib needs a target solid: extrude a profile first (the rib grows the last extrusion, the thread's precedent).",
      };
    }
    const profile = sketchProfileResolverOf(workbenchDocument)(
      createSketchDocumentId(specification.sketchId),
    );
    if (!profile.ok) {
      return {
        ok: false,
        code: profile.error.code,
        message: profile.error.message,
      };
    }
    const n = ribCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_rib${suffix}`);
    const featureId = createFeatureId(`feat_rib${suffix}`);
    const thicknessSlot: FeatureValueSlot = {
      resolution: thickness,
      literalId: createParameterId(`param_rib_thickness${suffix}`),
      literalName: `ribThickness${suffix}`,
      toLiteralValue: length,
    };
    const thicknessCommand = featureSlotCreateCommand(thicknessSlot);
    const committed = documentApi.applyTransaction({
      commands: [
        ...(thicknessCommand === null ? [] : [thicknessCommand]),
        { type: "body.create", id: bodyId, name: `ribbed ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "rib",
          inputs: [
            { kind: "feature", id: target.id },
            {
              kind: "sketch",
              id: createSketchDocumentId(specification.sketchId),
            },
            {
              kind: "parameter",
              id: featureSlotInputId(thicknessSlot),
            },
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
    setRibCount(n);
    setActiveScene("rib");
    return { ok: true };
  };

  // The Phase 41 scale action: validate the factor, then commit the scale
  // parameter and the scale feature targeting the document's LAST EXTRUDE
  // in ONE atomic transaction. A refusal commits nothing. Phase 21: a
  // `$name` factor references the existing parameter (no creation, no
  // literal-only battery) — the draft action's seam.
  const handleScale = (specification: ScaleInputRef): FeatureFormOutcome => {
    const factor = resolveFeatureNumberValue(
      specification.factor,
      workbenchDocument.parameters,
      { dimension: "dimensionless", label: "The scale factor" },
    );
    if (!factor.ok) return factor;
    if (factor.kind === "number") {
      const validation = validateScaleSubmission({ factor: factor.value });
      if (!validation.ok) return validation;
    }
    const target = richnessTargetFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A scale needs a target solid: extrude a profile first (the thread's precedent).",
      };
    }
    const n = scaleCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_scale${suffix}`);
    const featureId = createFeatureId(`feat_scale${suffix}`);
    const factorSlot: FeatureValueSlot = {
      resolution: factor,
      literalId: createParameterId(`param_scale_factor${suffix}`),
      literalName: `scaleFactor${suffix}`,
      toLiteralValue: dimensionless,
    };
    const factorCommand = featureSlotCreateCommand(factorSlot);
    const committed = documentApi.applyTransaction({
      commands: [
        ...(factorCommand === null ? [] : [factorCommand]),
        { type: "body.create", id: bodyId, name: `scaled ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "scale",
          inputs: [
            { kind: "feature", id: target.id },
            {
              kind: "parameter",
              id: featureSlotInputId(factorSlot),
            },
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
    setScaleCount(n);
    setActiveScene("scale");
    return { ok: true };
  };

  // The Phase 41 thicken action: validate the wall thickness, then commit
  // the thicken parameter and the thicken feature targeting the document's
  // LAST EXTRUDE in ONE atomic transaction. A refusal commits nothing.
  // Phase 21: a `$name` thickness references the existing parameter (no
  // creation, no literal-only battery) — the draft action's seam.
  const handleThicken = (
    specification: ThickenInputRef,
  ): FeatureFormOutcome => {
    const thickness = resolveFeatureNumberValue(
      specification.thicknessMm,
      workbenchDocument.parameters,
      { dimension: "length", label: "The wall thickness" },
    );
    if (!thickness.ok) return thickness;
    if (thickness.kind === "number") {
      const validation = validateThickenSubmission({
        thicknessMm: thickness.value,
      });
      if (!validation.ok) return validation;
    }
    const target = richnessTargetFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A thicken needs a target solid: extrude a profile first (the thread's precedent).",
      };
    }
    const n = thickenCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_thicken${suffix}`);
    const featureId = createFeatureId(`feat_thicken${suffix}`);
    const thicknessSlot: FeatureValueSlot = {
      resolution: thickness,
      literalId: createParameterId(`param_thicken_thickness${suffix}`),
      literalName: `wallThickness${suffix}`,
      toLiteralValue: length,
    };
    const thicknessCommand = featureSlotCreateCommand(thicknessSlot);
    const committed = documentApi.applyTransaction({
      commands: [
        ...(thicknessCommand === null ? [] : [thicknessCommand]),
        { type: "body.create", id: bodyId, name: `hollowed ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "thicken",
          inputs: [
            { kind: "feature", id: target.id },
            {
              kind: "parameter",
              id: featureSlotInputId(thicknessSlot),
            },
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
    setThickenCount(n);
    setActiveScene("thicken");
    return { ok: true };
  };

  // The Phase 41 split action: commit the side parameter and the split
  // feature (the picked datum plane, targeting the document's LAST
  // EXTRUDE) in ONE atomic transaction. A refusal commits nothing.
  const handleSplit = (specification: {
    readonly datumPlaneId: string;
    readonly side: 1 | -1;
  }): FeatureFormOutcome => {
    const validation = validateSplitSubmission({ side: specification.side });
    if (!validation.ok) return validation;
    const target = richnessTargetFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A split needs a target solid: extrude a profile first (the thread's precedent).",
      };
    }
    const n = splitCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_split${suffix}`);
    const featureId = createFeatureId(`feat_split${suffix}`);
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "parameter.create",
          id: createParameterId(`param_split_side${suffix}`),
          name: `splitSide${suffix}`,
          value: dimensionless(specification.side),
        },
        { type: "body.create", id: bodyId, name: `split ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "split",
          inputs: [
            { kind: "feature", id: target.id },
            { kind: "datum", id: createDatumId(specification.datumPlaneId) },
            {
              kind: "parameter",
              id: createParameterId(`param_split_side${suffix}`),
            },
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
    setSplitCount(n);
    setActiveScene("split");
    return { ok: true };
  };

  // The Phase 43 pattern action (the pattern editor's submission seam):
  // validate the legs and skips (the action-time battery), then commit
  // each leg's direction/count/spacing parameters, each skip's ordinal
  // parameter, and the patternFeature feature targeting the document's
  // LAST EXTRUDE (the thread precedent) in ONE atomic transaction — the
  // bridge's own greedy layout: leg triples first, skip ordinals after.
  // A refusal commits nothing.
  const handlePattern = (specification: {
    readonly legs: readonly {
      readonly directionDeg: number;
      readonly count: number;
      readonly spacingMm: number;
    }[];
    readonly skips: readonly number[];
  }): FeatureFormOutcome => {
    const validation = validatePatternSubmission(specification);
    if (!validation.ok) return validation;
    const target = patternTargetFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A pattern needs a target solid: extrude a profile first (the thread's precedent).",
      };
    }
    const n = patternCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_pattern${suffix}`);
    const featureId = createFeatureId(`feat_pattern${suffix}`);
    const parameterCommands: Parameters<
      typeof documentApi.applyTransaction
    >[0]["commands"][number][] = [
      {
        type: "parameter.create",
        id: createParameterId(`param_pattern${suffix}_direction1`),
        name: `pattern${suffix}Direction1`,
        value: angle(
          ((specification.legs[0]?.directionDeg ?? 0) * Math.PI) / 180,
        ),
      },
      {
        type: "parameter.create",
        id: createParameterId(`param_pattern${suffix}_count1`),
        name: `pattern${suffix}Count1`,
        value: dimensionless(specification.legs[0]?.count ?? 3),
      },
      {
        type: "parameter.create",
        id: createParameterId(`param_pattern${suffix}_spacing1`),
        name: `pattern${suffix}Spacing1`,
        value: length(specification.legs[0]?.spacingMm ?? 20),
      },
    ];
    const legParameterIds: ReturnType<typeof createParameterId>[] = [
      createParameterId(`param_pattern${suffix}_direction1`),
      createParameterId(`param_pattern${suffix}_count1`),
      createParameterId(`param_pattern${suffix}_spacing1`),
    ];
    for (let index = 1; index < specification.legs.length; index += 1) {
      const leg = specification.legs[index];
      if (leg === undefined) continue;
      const number = String(index + 1);
      parameterCommands.push(
        {
          type: "parameter.create",
          id: createParameterId(`param_pattern${suffix}_direction${number}`),
          name: `pattern${suffix}Direction${number}`,
          value: angle((leg.directionDeg * Math.PI) / 180),
        },
        {
          type: "parameter.create",
          id: createParameterId(`param_pattern${suffix}_count${number}`),
          name: `pattern${suffix}Count${number}`,
          value: dimensionless(leg.count),
        },
        {
          type: "parameter.create",
          id: createParameterId(`param_pattern${suffix}_spacing${number}`),
          name: `pattern${suffix}Spacing${number}`,
          value: length(leg.spacingMm),
        },
      );
      legParameterIds.push(
        createParameterId(`param_pattern${suffix}_direction${number}`),
        createParameterId(`param_pattern${suffix}_count${number}`),
        createParameterId(`param_pattern${suffix}_spacing${number}`),
      );
    }
    for (const [index, skip] of specification.skips.entries()) {
      const number = String(index + 1);
      parameterCommands.push({
        type: "parameter.create",
        id: createParameterId(`param_pattern${suffix}_skip${number}`),
        name: `pattern${suffix}Skip${number}`,
        value: dimensionless(skip),
      });
      legParameterIds.push(
        createParameterId(`param_pattern${suffix}_skip${number}`),
      );
    }
    const committed = documentApi.applyTransaction({
      commands: [
        ...parameterCommands,
        {
          type: "body.create",
          id: bodyId,
          name: `patterned ${String(n)}`,
        },
        {
          type: "feature.create",
          id: featureId,
          kind: "patternFeature",
          inputs: [
            { kind: "feature", id: target.id },
            ...legParameterIds.map((id) => ({
              kind: "parameter" as const,
              id,
            })),
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
    setPatternCount(n);
    setActiveScene("patternFeature");
    return { ok: true };
  };

  // The Phase 43 path-pattern action: validate the numbers, resolve the
  // picked path sketch through the same path seam the executor bridge
  // rides (a doomed path never commits), then commit the count/spacing/
  // orientation parameters and the patternPath feature in ONE atomic
  // transaction. A refusal commits nothing.
  const handlePatternPath = (specification: {
    readonly sketchId: string;
    readonly count: number;
    readonly spacingMm: number;
    readonly orientation: number;
  }): FeatureFormOutcome => {
    const validation = validatePatternPathSubmission(specification);
    if (!validation.ok) return validation;
    const target = patternTargetFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A path pattern needs a target solid: extrude a profile first (the thread's precedent).",
      };
    }
    const path = sketchPathResolverOf(workbenchDocument)(
      createSketchDocumentId(specification.sketchId),
    );
    if (!path.ok) {
      return {
        ok: false,
        code: path.error.code,
        message: path.error.message,
      };
    }
    const n = patternPathCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_patternpath${suffix}`);
    const featureId = createFeatureId(`feat_patternpath${suffix}`);
    const countId = createParameterId(`param_patternpath_count${suffix}`);
    const spacingId = createParameterId(`param_patternpath_spacing${suffix}`);
    const orientationId = createParameterId(
      `param_patternpath_orientation${suffix}`,
    );
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "parameter.create",
          id: countId,
          name: `pathCount${suffix}`,
          value: dimensionless(specification.count),
        },
        {
          type: "parameter.create",
          id: spacingId,
          name: `pathSpacing${suffix}`,
          value: length(specification.spacingMm),
        },
        {
          type: "parameter.create",
          id: orientationId,
          name: `pathOrientation${suffix}`,
          value: dimensionless(specification.orientation),
        },
        {
          type: "body.create",
          id: bodyId,
          name: `path patterned ${String(n)}`,
        },
        {
          type: "feature.create",
          id: featureId,
          kind: "patternPath",
          inputs: [
            { kind: "feature", id: target.id },
            {
              kind: "sketch",
              id: createSketchDocumentId(specification.sketchId),
            },
            { kind: "parameter", id: countId },
            { kind: "parameter", id: spacingId },
            { kind: "parameter", id: orientationId },
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
    setPatternPathCount(n);
    setActiveScene("patternPath");
    return { ok: true };
  };

  // The Phase 43 mirror action: validate the merge option, then commit
  // the merge parameter and the mirror feature (the picked datum plane,
  // targeting the document's LAST EXTRUDE) in ONE atomic transaction. A
  // refusal commits nothing.
  const handleMirror = (specification: {
    readonly datumPlaneId: string;
    readonly merge: number;
  }): FeatureFormOutcome => {
    const validation = validateMirrorSubmission({ merge: specification.merge });
    if (!validation.ok) return validation;
    const target = patternTargetFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A mirror needs a target solid: extrude a profile first (the thread's precedent).",
      };
    }
    const n = mirrorCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_mirror${suffix}`);
    const featureId = createFeatureId(`feat_mirror${suffix}`);
    const mergeId = createParameterId(`param_mirror_merge${suffix}`);
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "parameter.create",
          id: mergeId,
          name: `mirrorMerge${suffix}`,
          value: dimensionless(specification.merge),
        },
        { type: "body.create", id: bodyId, name: `mirrored ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "mirror",
          inputs: [
            { kind: "feature", id: target.id },
            { kind: "datum", id: createDatumId(specification.datumPlaneId) },
            { kind: "parameter", id: mergeId },
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
    setMirrorCount(n);
    setActiveScene("mirror");
    return { ok: true };
  };

  // The Phase 44 boolean action: validate the operand selection, then
  // commit the boolean feature (the EXISTING union/subtract/intersect
  // bridge kinds over the operands' producing features) — and, when the
  // tools are consumed rather than kept, the tool bodies' visibility
  // flags — in ONE atomic transaction. An operand is valid when its body
  // carries a scene the document can compute (`sceneOperandOfBody`): a
  // plain extrusion's output, or a composition's — pad, hole, boolean,
  // moved body — whose computed solid the scene pass hands over. A refusal
  // commits nothing.
  const handleBoolean = (specification: {
    readonly operation: BooleanOperation;
    readonly targetBodyId: string;
    readonly toolBodyIds: readonly string[];
    readonly keepToolBodies: boolean;
  }): FeatureFormOutcome => {
    const validation = validateBooleanSubmission(specification);
    if (!validation.ok) return validation;
    const targetFeature = featureProducingBody(
      workbenchDocument,
      specification.targetBodyId,
    );
    if (
      targetFeature === undefined ||
      sceneOperandOfBody(workbenchDocument, specification.targetBodyId) === null
    ) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A boolean's target body must carry a computable scene — an extrusion's output or a composition's (pad, hole, boolean, or moved body).",
      };
    }
    const toolFeatures: { kind: "feature"; id: FeatureId }[] = [];
    for (const toolBodyId of specification.toolBodyIds) {
      const toolFeature = featureProducingBody(workbenchDocument, toolBodyId);
      if (
        toolFeature === undefined ||
        sceneOperandOfBody(workbenchDocument, toolBodyId) === null
      ) {
        return {
          ok: false,
          code: "kernel/feature-input-invalid",
          message:
            "A boolean's tool body must carry a computable scene — an extrusion's output or a composition's (pad, hole, boolean, or moved body).",
        };
      }
      toolFeatures.push({ kind: "feature", id: toolFeature.id });
    }
    const n = booleanCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_boolean${suffix}`);
    const featureId = createFeatureId(`feat_boolean${suffix}`);
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "body.create",
          id: bodyId,
          name: `${specification.operation} ${String(n)}`,
        },
        {
          type: "feature.create",
          id: featureId,
          kind: specification.operation,
          inputs: [{ kind: "feature", id: targetFeature.id }, ...toolFeatures],
          outputs: [bodyId],
        },
        // Consume = hide the TOOL bodies (the keep-tool toggle's exact
        // scope): the display flags land in the same atomic transaction,
        // so undo restores the display state with the feature.
        ...(specification.keepToolBodies
          ? []
          : specification.toolBodyIds.map((toolBodyId) => ({
              type: "body.update" as const,
              id: createBodyId(toolBodyId),
              visible: false,
            }))),
      ],
    });
    if (!committed.ok) {
      return {
        ok: false,
        code: committed.error.code,
        message: committed.error.message,
      };
    }
    setBooleanCount(n);
    setActiveScene("boolean");
    return { ok: true };
  };

  // The Phase 44 move-body action: commit the translate parameters and
  // the translate feature (the EXISTING kind, grown with the optional
  // rotation pair) targeting the document's LAST EXTRUDE in ONE atomic
  // transaction. A refusal commits nothing.
  const handleMoveBody = (specification: {
    readonly offsetMm: readonly [number, number, number];
    readonly rotation: {
      readonly axis: 1 | 2 | 3;
      readonly angleDeg: number;
    } | null;
  }): FeatureFormOutcome => {
    const validation = validateMoveBodySubmission(specification);
    if (!validation.ok) return validation;
    const target = moveBodyTargetFeatureOf(workbenchDocument);
    if (target === undefined) {
      return {
        ok: false,
        code: "kernel/feature-input-invalid",
        message:
          "A move needs a body to move: extrude a profile first (the thread's precedent).",
      };
    }
    const n = moveBodyCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const bodyId = createBodyId(`body_moved${suffix}`);
    const featureId = createFeatureId(`feat_move${suffix}`);
    const parameterIds = [
      createParameterId(`param_move_x${suffix}`),
      createParameterId(`param_move_y${suffix}`),
      createParameterId(`param_move_z${suffix}`),
      ...(specification.rotation === null
        ? []
        : [
            createParameterId(`param_move_axis${suffix}`),
            createParameterId(`param_move_angle${suffix}`),
          ]),
    ];
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "parameter.create",
          id: parameterIds[0],
          name: `moveX${suffix}`,
          value: length(specification.offsetMm[0]),
        },
        {
          type: "parameter.create",
          id: parameterIds[1],
          name: `moveY${suffix}`,
          value: length(specification.offsetMm[1]),
        },
        {
          type: "parameter.create",
          id: parameterIds[2],
          name: `moveZ${suffix}`,
          value: length(specification.offsetMm[2]),
        },
        ...(specification.rotation === null
          ? []
          : [
              {
                type: "parameter.create" as const,
                id: parameterIds[3],
                name: `moveAxis${suffix}`,
                value: dimensionless(specification.rotation.axis),
              },
              {
                type: "parameter.create" as const,
                id: parameterIds[4],
                name: `moveAngle${suffix}`,
                value: angle(specification.rotation.angleDeg, "deg"),
              },
            ]),
        { type: "body.create", id: bodyId, name: `moved ${String(n)}` },
        {
          type: "feature.create",
          id: featureId,
          kind: "translate",
          inputs: [
            { kind: "feature", id: target.id },
            ...parameterIds.map((id) => ({ kind: "parameter" as const, id })),
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
    setMoveBodyCount(n);
    setActiveScene("moveBody");
    return { ok: true };
  };

  // The Phase 44 body-management actions: each concern rides its own
  // `body.update` command (the command layer's partial-update design),
  // committed as a one-command transaction the history records.
  const handleBodyRename = (
    bodyId: string,
    name: string,
  ): FeatureFormOutcome => {
    const validation = validateBodyRenameSubmission({ name });
    if (!validation.ok) return validation;
    const committed = documentApi.applyTransaction({
      commands: [{ type: "body.update", id: createBodyId(bodyId), name }],
    });
    if (!committed.ok) {
      return {
        ok: false,
        code: committed.error.code,
        message: committed.error.message,
      };
    }
    return { ok: true };
  };

  const handleBodyVisibility = (
    bodyId: string,
    visible: boolean,
  ): FeatureFormOutcome => {
    const committed = documentApi.applyTransaction({
      commands: [{ type: "body.update", id: createBodyId(bodyId), visible }],
    });
    if (!committed.ok) {
      return {
        ok: false,
        code: committed.error.code,
        message: committed.error.message,
      };
    }
    return { ok: true };
  };

  // The Phase 59 appearance action: the preset's VALUES are copied into
  // the body record (the library is an authoring aid, never a reference);
  // `presetId: null` clears the record back to the scene default. One
  // `body.update` command per activation, the Phase 44 concern-per-command
  // discipline.
  const handleBodyAppearance = (
    bodyId: string,
    presetId: string | null,
  ): FeatureFormOutcome => {
    if (presetId === null) {
      const cleared = documentApi.applyTransaction({
        commands: [
          {
            type: "body.update",
            id: createBodyId(bodyId),
            appearance: null,
          },
        ],
      });
      if (!cleared.ok) {
        return {
          ok: false,
          code: cleared.error.code,
          message: cleared.error.message,
        };
      }
      return { ok: true };
    }
    const preset = appearanceLibraryEntry(presetId);
    if (preset === undefined) {
      return {
        ok: false,
        code: "appearance/malformed",
        message: `No appearance preset "${presetId}" exists in the library.`,
      };
    }
    const committed = documentApi.applyTransaction({
      commands: [
        {
          type: "body.update",
          id: createBodyId(bodyId),
          appearance: { ...preset.appearance },
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
    return { ok: true };
  };

  const handleBodyIsolate = (
    bodyId: string,
    isolated: boolean,
  ): FeatureFormOutcome => {
    const committed = documentApi.applyTransaction({
      commands: [{ type: "body.update", id: createBodyId(bodyId), isolated }],
    });
    if (!committed.ok) {
      return {
        ok: false,
        code: committed.error.code,
        message: committed.error.message,
      };
    }
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

  /**
   * The active section display request: present exactly when the document
   * carries a section record AND the clip toggle is on — view mode rides
   * along as the display choice. Absent when clipped off: the unsectioned
   * path (the boot state).
   */
  const activeSectionRequest: SectionDisplayRequest | null = useMemo(() => {
    if (documentSection === null || !sectionClipped) return null;
    return {
      origin: documentSection.origin,
      normal: documentSection.normal,
      keepSide: documentSection.keepSide,
      viewMode: sectionViewMode,
    };
  }, [documentSection, sectionClipped, sectionViewMode]);

  /** Toggles the section clip on/off (session display state, Phase 46). */
  const toggleSectionClipped = useCallback((): void => {
    setSectionClipped((current) => !current);
  }, []);

  /** Toggles the section VIEW mode (the cut solid with cap faces). */
  const toggleSectionViewMode = useCallback((): void => {
    setSectionViewMode((current) => !current);
  }, []);

  // The computed-face source feeds the dispatch below through a ref: the
  // settle-produced projection refreshes the memo WITHOUT re-triggering
  // the dispatch (the effect's triggers are document identity, display
  // state, and the datum-follow digest — a settle alone is not one). The
  // sync effect is declared FIRST so the same render's pass reads the
  // current source.
  useEffect(() => {
    computedFacesRef.current = computedFaces;
  }, [computedFaces]);

  // The scene dispatch (Phase 16 owner fix — "CAD software lets you control
  // what you see"): the applied scene IS the applied document. Every
  // document/suppression/rollback change rebuilds the DOCUMENT scene
  // request — one body-scene per lineage tip of the active timeline
  // (./document-scene: consumed bodies are absorbed by the compositions
  // that rebuild them, a rolled-back state un-absorbs its parked features'
  // bases) — and dispatches it as ONE settle whose volume is the sum of
  // the rendered bodies, the keep rule applied per body at computation.
  // The emptiness decision is PRE-display-filter: an ALL-HIDDEN document
  // still dispatches the document scene (which settles the honest empty
  // scene) — it must never re-materialize the plate. Only when NO active
  // feature's scene resolves (the boot plate document among them) does the
  // plate dispatch follow the stored hole diameter.
  // The datum-follow digest: documents WITHOUT a datum anchored on a
  // computed body keep an empty digest — their dispatch rhythm is exactly
  // as before. With one, the digest rides the settled scene's computed
  // face planes: an edit that moves such a face (a pocket deepened under a
  // standoff) settles a changed digest, which re-triggers this pass ONCE
  // with the fresh planes — the datum-anchored feature follows the face.
  // The pass converges (the anchor body's own mesh does not depend on the
  // datum-anchored feature), never loops.
  // Declared AFTER the boot effect above so the mount pass runs with the
  // session already in sessionRef; the action counters stay as re-trigger
  // insurance (an action that commits always changes the document, so the
  // dispatch they force is the same request the document change forces).
  useEffect(() => {
    const bodies = documentSceneBodies(
      workbenchDocument,
      suppressed,
      rollback,
      computedFacesRef.current ?? undefined,
    );
    if (bodies.length > 0) {
      sessionRef.current?.dispatchDocument(
        bodies,
        renderableBodyIds(workbenchDocument),
      );
      return;
    }
    if (storedHole !== null) {
      sessionRef.current?.dispatch(storedHole, activeSectionRequest);
    }
  }, [
    activeScene,
    workbenchDocument,
    suppressed,
    rollback,
    storedHole,
    activeSectionRequest,
    datumFollowDigest,
    extrudeCount,
    revolveCount,
    sweepCount,
    loftCount,
    helixCount,
    threadCount,
    ribCount,
    scaleCount,
    thickenCount,
    splitCount,
    patternCount,
    patternPathCount,
    mirrorCount,
    booleanCount,
    moveBodyCount,
    holeCount,
    structuredHoleCount,
    curveCount,
    surfaceCount,
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

  // The document scene's per-body measurements: every rendered body's own
  // kernel numbers, keyed by body id — what the per-body readouts answer
  // from when the applied scene IS the document (Phase 16).
  const measuredBodies =
    applied === null
      ? undefined
      : "bodies" in applied.state.measurement
        ? new Map(
            applied.state.measurement.bodies.map((body) => [
              body.bodyId,
              body.measurement,
            ]),
          )
        : undefined;

  // The bounds inspection (Phase 27.1): the scene solid's kernel-measured
  // bounds displayed when the selection resolves to exactly the measured
  // body, with the booted kernel's declared tightness (see
  // ./bounds-inspection). The document scene answers per body — the
  // selected body's own bounds.
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
    measuredBodies,
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
  // The section inspection (Phase 46): the active section plane's kernel
  // face measurements — present exactly when the settled scene cut one (see
  // ./section-inspection).
  const sectionState = sectionInspectionReadout({
    selected: selectionApi.selected,
    features: workbenchDocument.features,
    sceneBodyId:
      applied === null
        ? undefined
        : applied.state.projection.objects.find(
            (object) => object.bodyId !== undefined,
          )?.bodyId,
    sectionArea:
      applied === null || applied.state.section === undefined
        ? undefined
        : applied.state.section.areaMm2,
    sectionCentroid:
      applied === null || applied.state.section === undefined
        ? undefined
        : applied.state.section.centroidMm,
  });

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
    measuredBodies,
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

  // The Phase 47 curve creation action (the Formedible form's submission
  // seam): builds the payload through the curve module's own authoring
  // validators and payload builders (see ./curves — the validators and the
  // shared semantic battery run BEFORE anything commits), then commits the
  // curve.create command in one atomic transaction and switches the scene
  // to the curves surface (the dispatch re-drives the solids beneath). A
  // refusal commits nothing and hands the structured outcome back to the
  // form — the datum creation seam verbatim.
  const handleCreateCurve = (authoring: CurveAuthoring): FeatureFormOutcome => {
    const built = curvePayloadOf(authoring);
    if (built.problems.length > 0 || built.payload === undefined) {
      return {
        ok: false,
        code: "workbench/curve-invalid",
        message: built.problems.map((problem) => problem.message).join(" "),
      };
    }
    const n = curveCount + 1;
    const suffix = n === 1 ? "" : String(n);
    const name = authoring.name.trim();
    const commit = documentApi.applyTransaction({
      commands: [
        {
          type: "curve.create",
          id: createCurveId(`crv_curve${suffix}`),
          name,
          curve: built.payload,
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
    setCurveCount(n);
    setActiveScene("curves");
    return { ok: true };
  };

  // The curves machine surface: every curve record with its kind and its
  // deterministic scene segment count (the same shared evaluation the
  // viewport overlay draws), canonical JSON — the e2e battery asserts
  // presence and identity without reading pixels (the datums surface's
  // discipline).
  const curvesJson = useMemo(
    () =>
      JSON.stringify(
        workbenchDocument.curves.map((curve) => ({
          id: curve.id,
          kind: curve.curve.kind,
          name: curve.name,
          segments: curveSceneSegments(curve.curve).length,
        })),
      ),
    [workbenchDocument],
  );

  // The datums machine surface: every datum record with its kind and, for
  // PLANE datums, the session-resolved plane (or the structured failure),
  // canonical JSON. A plane datum whose resolution fails surfaces its
  // failure code — the surface tells the truth about unanchored datums
  // instead of hiding them. A NON-plane datum (axis, point, cSys) reports
  // `resolved: null` with its kind: this surface resolves PLANES, and a
  // healthy axis datum is not a failed plane resolution. The computed-face
  // source rides along so a datum anchored on a computed body reads
  // resolved against the same settled scene the viewport draws.
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
      const plane = resolveSessionDatumPlane(
        workbenchDocument,
        datum.id,
        computedFaces ?? undefined,
      );
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
  }, [workbenchDocument, computedFaces]);

  // -- The Phase 57 configuration switch ------------------------------------
  // The ACTIVE configuration is session state (ADR: derived data, never
  // persisted): applying a row commits the effective values as ordinary
  // transactions, so the diff/stale machinery re-derives the affected set
  // with no new invalidation path. The BASE values a row's overrides
  // displaced (and the bodies a row hid) are tracked so switching back — or
  // to another row — restores them; the rows themselves stay the only
  // persisted deltas.
  const [activeConfigurationId, setActiveConfigurationId] =
    useState<ConfigurationId | null>(null);
  const [configurationNotice, setConfigurationNotice] = useState<string | null>(
    null,
  );
  const baseValuesRef = useRef<ReadonlyMap<string, AnyDimensionalValue>>(
    new Map(),
  );
  const configHiddenBodiesRef = useRef<ReadonlySet<BodyId>>(new Set());

  const applyConfiguration = useCallback(
    (id: ConfigurationId | null): void => {
      const document = documentApi.document;
      const evaluated =
        id === null
          ? null
          : applyDocumentConfiguration(document, document.configurations, id);
      if (id !== null && !evaluated?.ok) {
        setConfigurationNotice(
          evaluated && !evaluated.ok
            ? `${evaluated.error.code}: ${evaluated.error.message}`
            : `No configuration ${String(id)} exists.`,
        );
        return;
      }
      const effective = evaluated?.ok === true ? evaluated.value : null;
      const overrides = new Map(
        (effective === null
          ? []
          : (document.configurations.find(
              (configuration) => configuration.id === id,
            )?.parameterOverrides ?? [])
        ).map((override) => [override.parameterId, override.value]),
      );
      const previousBase = baseValuesRef.current;
      const nextBase = new Map(previousBase);
      const commands: CadCommand[] = [];
      for (const parameter of document.parameters.parameters) {
        const overrideValue = overrides.get(parameter.id);
        const baseValue = previousBase.get(parameter.id) ?? parameter.value;
        const desiredValue = overrideValue ?? baseValue;
        if (!equalQuantity(desiredValue, parameter.value)) {
          commands.push({
            type: "parameter.set",
            id: parameter.id,
            value: desiredValue,
          });
        }
        if (overrideValue !== undefined && !previousBase.has(parameter.id)) {
          nextBase.set(parameter.id, parameter.value);
        }
      }
      const previousHidden = configHiddenBodiesRef.current;
      const nextHidden: ReadonlySet<BodyId> = new Set(
        effective?.hiddenBodies ?? [],
      );
      for (const bodyId of previousHidden) {
        if (!nextHidden.has(bodyId)) {
          commands.push({ type: "body.update", id: bodyId, visible: true });
        }
      }
      for (const bodyId of nextHidden) {
        if (!previousHidden.has(bodyId)) {
          commands.push({ type: "body.update", id: bodyId, visible: false });
        }
      }
      if (commands.length > 0) {
        const commit = documentApi.applyTransaction({ commands });
        if (!commit.ok) {
          setConfigurationNotice(
            `${commit.error.code}: ${commit.error.message}`,
          );
          return;
        }
      }
      baseValuesRef.current = nextBase;
      configHiddenBodiesRef.current = nextHidden;
      setSuppressed(new Set(effective?.suppressedFeatures ?? []));
      setActiveConfigurationId(id);
      setConfigurationNotice(null);
    },
    [documentApi, setSuppressed],
  );

  // Creating a row captures the CURRENT parameter values as its overrides —
  // the authored-now state becomes the named row; suppression and hidden
  // bodies start empty and stay empty until a later edit carries them.
  const createConfiguration = useCallback(
    (name: string): void => {
      const document = documentApi.document;
      const committed = documentApi.applyTransaction({
        commands: [
          {
            type: "configuration.create",
            name,
            parameterOverrides: document.parameters.parameters.map(
              (parameter) => ({
                parameterId: parameter.id,
                value: parameter.value,
              }),
            ),
          },
        ],
      });
      if (!committed.ok) {
        setConfigurationNotice(
          `${committed.error.code}: ${committed.error.message}`,
        );
        return;
      }
      setConfigurationNotice(null);
    },
    [documentApi],
  );

  const deleteConfiguration = useCallback(
    (id: ConfigurationId): void => {
      const committed = documentApi.applyTransaction({
        commands: [{ type: "configuration.delete", id }],
      });
      if (!committed.ok) {
        setConfigurationNotice(
          `${committed.error.code}: ${committed.error.message}`,
        );
        return;
      }
      if (activeConfigurationId === id) {
        baseValuesRef.current = new Map();
        configHiddenBodiesRef.current = new Set();
        setSuppressed(new Set());
        setActiveConfigurationId(null);
      }
      setConfigurationNotice(null);
    },
    [documentApi, activeConfigurationId, setSuppressed],
  );

  // The CSV parameter table: export is the domain's deterministic bytes;
  // import parses rows, matches them by name, and commits each matched
  // parameter as an ordinary parameter.set (one transaction).
  const exportParameterTableCsv = useCallback((): string => {
    const csv = serializeParameterTableCsv(documentApi.document);
    return csv;
  }, [documentApi]);

  const importParameterTableCsv = useCallback(
    (text: string): void => {
      const document = documentApi.document;
      const rows = parseParameterTableCsv(text);
      if (!rows.ok) {
        setConfigurationNotice(`${rows.error.code}: ${rows.error.message}`);
        return;
      }
      const overrides = overridesFromCsvRows(document.parameters, rows.value);
      if (!overrides.ok) {
        setConfigurationNotice(
          `${overrides.error.code}: ${overrides.error.message}`,
        );
        return;
      }
      const commit = documentApi.applyTransaction({
        commands: overrides.value.map((override): CadCommand => ({
          type: "parameter.set",
          id: override.parameterId,
          value: override.value,
        })),
      });
      if (!commit.ok) {
        setConfigurationNotice(`${commit.error.code}: ${commit.error.message}`);
        return;
      }
      setConfigurationNotice(null);
    },
    [documentApi],
  );

  // The configurations machine surface: every row with its delta counts and
  // the active id, canonical JSON — additive; the e2e battery asserts
  // presence and identity without reading pixels (the datums discipline).
  const configurationsJson = useMemo(
    () =>
      JSON.stringify({
        active: activeConfigurationId,
        rows: documentApi.document.configurations.map((configuration) => ({
          id: configuration.id,
          name: configuration.name,
          overrides: configuration.parameterOverrides.length,
          suppressed: configuration.suppressedFeatures.length,
          hidden: configuration.hiddenBodies.length,
        })),
      }),
    [documentApi.document, activeConfigurationId],
  );

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
    sectionClipped,
    sectionViewMode,
    toggleSectionClipped,
    toggleSectionViewMode,
    sectionState,
    timelineJson,
    configurationsJson,
    activeConfigurationId,
    configurationNotice,
    applyConfiguration,
    createConfiguration,
    deleteConfiguration,
    exportParameterTableCsv,
    importParameterTableCsv,
    handleExtrude,
    handleRevolve,
    handleHole,
    handleStructuredHole,
    handleSaveSketch,
    handleSweep,
    handleCreateSheet,
    handleTrimSurface,
    handleThickenSurface,
    handleKnitSurface,
    handleOffsetSurface,
    handleLoft,
    handleHelix,
    handleThread,
    handleDraft,
    handleRib,
    handleScale,
    handleThicken,
    handleSplit,
    handlePattern,
    handlePatternPath,
    handleMirror,
    handleBoolean,
    handleMoveBody,
    handleBodyRename,
    handleBodyAppearance,
    handleBodyVisibility,
    handleBodyIsolate,
    handleSketchOnFace,
    sketchBootWorkplane: sketchAnchor === null ? null : sketchAnchor.workplane,
    datumsJson,
    handleCreateDatum,
    handleCreateCurve,
    curvesJson,
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
