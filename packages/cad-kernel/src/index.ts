/**
 * Public entry of `@slopcad/cad-kernel`, the pluggable geometry-kernel
 * abstraction (Phase 8). This package is React-free and UI-free; concrete
 * kernel adapters implement the contracts exported here.
 *
 * Surfaces:
 *
 * - `./contract` — the kernel-independent geometry contract (operations,
 *   inputs, measurements, structured errors).
 * - `./capabilities` — the declared-capability flags kernels report.
 * - `./opaque` — the opaque solid-handle type (and, for kernel implementers
 *   only, the handle-minting `createSolidTag`).
 * - `./fake-kernel` — the deterministic fake kernel.
 * - `./test-utils` — kernel-neutral semantic geometry assertions.
 * - `./contract-suite` — the shared suite any conforming kernel must pass.
 * - `./core-bridge` — the cad-core feature-executor bridge that executes a
 *   document's features against a kernel.
 * - `./worker-protocol` (and its `worker-*` siblings) — the versioned,
 *   serializable worker message protocol (Phase 10): envelope, operation
 *   vocabulary, ids, structured errors, and cancellation semantics.
 * - `./worker-transport`, `./worker-server`, `./worker-client`,
 *   `./worker-session` — the generic transport, the kernel-hosting server,
 *   the promise-based client, and the in-memory in-process session that
 *   wires them together (Phase 10.2).
 * - `./revision`, `./stale-result-guard`, `./stale-result-coordinator` —
 *   the Phase 10.4 stale-result protection: the monotonic revision identity
 *   binding computations to document state, the atomic check-and-apply
 *   gatekeeper that drops stale results observably, and the coordinator that
 *   stamps, guards, and keeps the worker's solid state leak-free under rapid
 *   updates.
 */

export { KERNEL_BACKEND_IDS } from "./backend-ids";
export type { KernelBackendId } from "./backend-ids";

export type { KernelCapabilities } from "./capabilities";

export {
  KERNEL_ERROR_CODES,
  SHEET_SURFACE_KINDS,
  tessellationTriangleCount,
} from "./contract";
export type {
  BoxInput,
  ChamferInput,
  ConeInput,
  DrawingViewInput,
  CylinderInput,
  FilletInput,
  GeometryKernel,
  HelixSpineInput,
  HelixSweepInput,
  KernelBounds,
  KernelError,
  KernelErrorCode,
  KernelResult,
  MirrorInput,
  MirrorPlaneAxis,
  MoveFaceInput,
  DeleteFaceInput,
  DeleteFaceKeepInput,
  DeleteFaceKeepResult,
  ProfileExtrudeInput,
  ProfileLoftInput,
  ProfileLoftSectionInput,
  ProfilePlacementInput,
  ProfileRevolveAxisInput,
  ProfileRevolveInput,
  ProfileSegmentInput,
  ProfileSweepInput,
  ReplaceFaceInput,
  ReplaceFacePlaneInput,
  RotationInput,
  SectionFaceMeasure,
  SectionInput,
  SectionResult,
  SheetExtendInput,
  SheetFillPatchInput,
  SheetKnitInput,
  SheetOffsetInput,
  SheetReplaceFaceInput,
  SheetThickenInput,
  SheetTrimInput,
  SheetSurfaceInput,
  SheetUnstitchInput,
  SheetUntrimInput,
  SheetSurfaceKind,
  ShellInput,
  SphereInput,
  SweepPathSegmentInput,
  Tessellation,
  ThickenInput,
  TransformInput,
  TranslationInput,
} from "./contract";
export type {
  IntersectionCurveInput,
  KernelSolid,
  KernelWire,
  ProfileSweepWireInput,
  WireCurveInput,
} from "./contract";

export {
  createFakeKernel,
  FAKE_KERNEL_CAPABILITIES,
  FAKE_KERNEL_ID,
  FAKE_KERNEL_VOLUME_RESOLUTION,
  FAKE_KERNEL_TESSELLATION_SEGMENTS,
  FAKE_KERNEL_TESSELLATION_RINGS,
  FAKE_BOX_TRIANGLE_COUNT,
  FAKE_BOX_EDGE_TABLE,
  FAKE_BOX_FACE_TABLE,
} from "./fake-kernel";

export {
  helixAngleAt,
  helixHeightAt,
  helixPointAt,
  helixProfilePolygon,
  helixRadiusAt,
  helixScrewContains,
  helixScrewVolume,
  helixStations,
  helixSweptAngle,
  helixSweepProblem,
  helixTransportPoint,
  helixTurnsOverlap,
  helixUntaperedLocalBounds,
  PROFILE_STATION_ANGLE_RAD,
} from "./helix-geometry";
export type { CanonicalHelixSpine, HelixSweepProblem } from "./helix-geometry";

export {
  ISO_METRIC_THREAD_TABLE,
  isoMetricThreadByDesignation,
  isoThreadDepth,
  isoThreadMinorDiameter,
  isoThreadToolLoop,
  isoThreadTriangleHeight,
  planThreadCut,
  REAL_THREAD_MODES,
  rotationAligningZTo,
  THREAD_MODES,
  threadHelixSpine,
} from "./thread-profile";
export type {
  IsoMetricThreadSize,
  ThreadCutPlan,
  ThreadMode,
} from "./thread-profile";

export { createSolidTag } from "./opaque";

export {
  applyMatrix3,
  axisAngleMatrix,
  decomposeSweepPath,
  loftAnalyticVolume,
  loftSectionPolygons,
  loftSectionsProblem,
  loftStations,
  morphPolygons,
  multiplyMatrix3,
  normalizeRevolveAxis,
  pointInPolygon,
  polygonMomentU,
  polygonSignedArea,
  profileLoopProblem,
  PROFILE_CLOSURE_TOLERANCE_MM,
  PROFILE_MAX_SEGMENT_ANGLE_RAD,
  revolveCrossesAxis,
  revolvePappusVolume,
  REVOLVE_AXIS_TOUCH_TOLERANCE_MM,
  revolveSignedExtremes,
  revolutionMeshTransform,
  sweepAnalyticVolume,
  sweepArcSignedSweep,
  sweepArcStation,
  sweepPathChordPoints,
  sweepPathClosed,
  sweepPathProblem,
  sweepPathSelfIntersects,
  sweepPieceStations,
  sweepProfileArcAxisCrossing,
  tessellateProfileLoop,
  tessellateRevolveProfile,
  transpose3,
} from "./profile-geometry";
export {
  PROFILE_SPLINE_DEFLECTION_MM,
  PROFILE_SPLINE_MAX_DEPTH,
  splineBezierChain,
  splineEndPoint,
  splinePointsProblem,
  splineSegmentPoint,
  splineStartPoint,
  tessellateSplineSegment,
} from "./profile-splines";
export type { SplineBezierSegment, SplinePoint2 } from "./profile-splines";
export {
  insetPolygon,
  polygonSelfIntersects,
  taperInsetDistanceMm,
  taperedExtrudeProblem,
  TAPER_ANGLE_LIMIT_RAD,
} from "./taper-geometry";
export type { TaperProblem } from "./taper-geometry";
export type {
  LoftSectionsProblem,
  ProfilePoint2,
  RevolveAxisFrame,
  SweepPiece,
  SweepStation,
  SweepXZ,
} from "./profile-geometry";
export type { SolidTag } from "./opaque";

// NOTE: `./contract-suite`'s `defineKernelContractSuite` (and the suite's
// tolerance constants) is deliberately NOT re-exported here: the contract
// suite is test tooling that imports vitest, and the runtime index must
// stay importable by browsers/consumers without a test runner. Import it
// from the `@slopcad/cad-kernel/contract-suite` subpath instead.

export {
  createKernelFeatureExecutor,
  BRIDGE_FEATURE_KINDS,
  HOLE_TOOL_OVERSHOOT_MM,
  PATTERN_COUNT_LIMIT,
  planArrayPatternInstances,
  planDatumMirror,
  planHoleCut,
  planSplitCut,
  rotationFromTo,
  SPLIT_TOOL_OVERSHOOT_MM,
} from "./core-bridge";
export { capFaceMeasure, CAP_FACE_PLANE_TOLERANCE } from "./section-geometry";
export type {
  ArrayPatternLeg,
  ArrayPatternPlan,
  BridgeFeatureKind,
  DatumMirrorPlan,
  HoleAxisSelector,
  HoleCutPlan,
  SplitCutPlan,
  KernelExecutionBridge,
  KernelExecutorContext,
  KernelPathResolution,
  KernelPathResolver,
  KernelProfileResolution,
  KernelProfileResolver,
  KernelResolvedPath,
  KernelResolvedProfile,
  KernelResolvedSketchPoints,
  KernelSketchPointsResolution,
  KernelSketchPointsResolver,
} from "./core-bridge";
export { sweepPathStationAt, sweepPathTotalLength } from "./path-geometry";
export type { SweepPathStation } from "./path-geometry";

export {
  HOLE_POSITION_LIMIT,
  HOLE_TYPE_VALUES,
  STRUCTURED_HOLE_TYPES,
  holeTipExtentMm,
  planStructuredHoleCut,
  rotationAligningYTo,
  structuredHoleAnalyticVolumeMm3,
  structuredHoleDatumInPlaneAxes,
  structuredHoleProblem,
  structuredHoleRoles,
  structuredHoleTypeOf,
  structuredHoleWorldInPlaneAxes,
} from "./hole-specification";
export type {
  StructuredHolePlan,
  StructuredHolePositionPlan,
  StructuredHoleProblem,
  StructuredHoleRole,
  StructuredHoleRoleKind,
  StructuredHoleSpec,
  StructuredHoleType,
} from "./hole-specification";

export {
  assertAreaClose,
  assertBoundsContain,
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  assertVolumeLessThan,
  DEFAULT_BOUNDS_TOLERANCE_MM,
  expectKernelFailure,
  unwrapKernelResult,
} from "./test-utils";
export type { TessellationValidityOptions } from "./test-utils";

export {
  isWorkerErrorCode,
  parseWorkerError,
  toWorkerError,
  workerError,
  workerParseError,
  WORKER_PROTOCOL_ERROR_CODES,
} from "./worker-errors";
export type {
  WorkerError,
  WorkerErrorDataValue,
  WorkerErrorCode,
  WorkerParseError,
} from "./worker-errors";

export {
  createWorkerIdGenerator,
  createWorkerRequestId,
  createWorkerSolidId,
  parseAnyWorkerId,
  parseWorkerRequestId,
  parseWorkerSolidId,
  WorkerIdGeneratorExhaustedError,
  WorkerIdValidationError,
  WORKER_ID_ERROR_CODES,
  WORKER_ID_GENERATOR_ERROR_CODES,
  WORKER_ID_KINDS,
  WORKER_ID_MAX_PAYLOAD_LENGTH,
  WORKER_ID_PREFIXES,
} from "./worker-ids";
export type {
  ParsedWorkerId,
  WorkerId,
  WorkerIdGeneratorState,
  WorkerIdErrorCode,
  WorkerIdKind,
  WorkerIdParseError,
  WorkerRequestId,
  WorkerSolidId,
} from "./worker-ids";

export {
  isWorkerOperationId,
  parseWorkerOperationInput,
  parseWorkerOperationResult,
  resultMintsSolids,
  serializeWorkerOperationInput,
  serializeWorkerOperationResult,
  BREP_EXPORT_UNSUPPORTED_CODE,
  BREP_IMPORT_UNSUPPORTED_CODE,
  STEP_IMPORT_UNSUPPORTED_CODE,
  TOPOLOGY_UNSUPPORTED_CODE,
  WORKER_OPERATION_IDS,
} from "./worker-operations";
export type {
  SerializedWorkerLength,
  SerializedWorkerOperationInput,
  SerializedWorkerOperationInputs,
  SerializedWorkerOperationResult,
  SerializedWorkerOperationResults,
  WorkerBoxInput,
  WorkerBrepExportInput,
  WorkerBrepExportResult,
  WorkerBrepExporter,
  WorkerBrepImportFailure,
  WorkerBrepImportInput,
  WorkerBrepImportResult,
  WorkerBrepImporter,
  WorkerChamferInput,
  WorkerConeInput,
  WorkerCylinderInput,
  WorkerDisposeResult,
  WorkerFilletInput,
  WorkerImportedBrepSolidRef,
  WorkerImportedOrigin,
  WorkerImportedSolidRef,
  WorkerOperationId,
  WorkerOperationInput,
  WorkerOperationInputs,
  WorkerOperationResult,
  WorkerOperationResults,
  WorkerRevolveAxisInput,
  WorkerRevolveInput,
  WorkerShellInput,
  WorkerSolidRefInput,
  WorkerSphereInput,
  WorkerStepImportFailure,
  WorkerStepImportInput,
  WorkerStepImportResult,
  WorkerStepImporter,
  WorkerSubtractInput,
  WorkerTessellationResult,
  WorkerTopologyInput,
  WorkerTopologyReporter,
  WorkerTopologyResult,
  WorkerTransformInput,
  WorkerTranslationVector,
  WorkerUnionInput,
  WorkerVolumeResult,
  WorkerBoundsResult,
} from "./worker-operations";

export {
  createWorkerCancel,
  createWorkerErrorResponse,
  createWorkerRequest,
  createWorkerSuccessResponse,
  decodeWorkerRequest,
  decodeWorkerResult,
  parseWorkerMessage,
  WORKER_MESSAGE_KINDS,
  WORKER_PROTOCOL_VERSION,
} from "./worker-protocol";
export type {
  DecodedWorkerRequest,
  WorkerCancelMessage,
  WorkerErrorResponseMessage,
  WorkerMessage,
  WorkerMessageKind,
  WorkerRequestMessage,
  WorkerResponseMessage,
  WorkerSuccessResponseMessage,
} from "./worker-protocol";

export { createWorkerCancellationLedger } from "./worker-cancellation";
export type {
  WorkerCancellationFinishDecision,
  WorkerCancellationLedger,
  WorkerCancellationRecordOutcome,
  WorkerCancellationStartDecision,
} from "./worker-cancellation";

export { createInMemoryTransportPair } from "./worker-transport";
export type {
  InMemoryWorkerTransportPair,
  WorkerTransport,
} from "./worker-transport";

export { createNodeWorkerTransport } from "./worker-node-transport";
export type { NodeWorkerMessagePort } from "./worker-node-transport";

// NOTE: `./node-worker-channel` (the node:worker_threads channel factory)
// is deliberately NOT re-exported here: the runtime index must stay
// importable by browsers/consumers without node builtins. Import it from
// the `@slopcad/cad-kernel/node-worker-channel` subpath instead (the
// node-side worker entries of the kernel backends do).

export {
  createWebWorkerTransport,
  isWebWorkerMessagePort,
} from "./worker-web-transport";
export type { WebWorkerMessagePort } from "./worker-web-transport";

export { bootWorkerChannel } from "./worker-boot";
export type {
  BootedWorkerChannel,
  WorkerBootFailure,
  WorkerCrashPort,
} from "./worker-boot";

export { createWorkerServer } from "./worker-server";
export type { WorkerServer, WorkerServerOptions } from "./worker-server";

export { createWorkerClient, WorkerRequestFailure } from "./worker-client";
export type { WorkerClient, WorkerClientOptions } from "./worker-client";

export { createInMemoryKernelSession } from "./worker-session";
export type {
  InMemoryKernelSession,
  InMemoryKernelSessionOptions,
} from "./worker-session";

export {
  createRevisionClock,
  createRevisionTag,
  REVISION_CLOCK_ERROR_CODES,
  RevisionClockExhaustedError,
  REVISION_ZERO,
} from "./revision";
export type {
  RevisionClock,
  RevisionClockErrorCode,
  RevisionTag,
} from "./revision";

export { createRevisionedState } from "./stale-result-guard";
export type {
  RevisionedResult,
  RevisionedState,
  RevisionedStateOptions,
  StaleDrop,
  StaleDropReason,
  StaleGuardDecision,
} from "./stale-result-guard";

export { createStaleResultCoordinator } from "./stale-result-coordinator";
export type {
  AppliedComputation,
  ComputationContext,
  ComputationOutcome,
  ComputationRun,
  DroppedComputation,
  StaleResultCoordinator,
  StaleResultCoordinatorOptions,
  SupersededComputationPolicy,
} from "./stale-result-coordinator";

export {
  canonicalizeCurve,
  curvePolyline,
  curveRecordProblems,
  evaluateWire,
  parallelTransportFrames,
  wireG1FailureIndex,
} from "./curve-geometry";

export type { SerializedCurve } from "@slopcad/cad-core";
