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

export { KERNEL_ERROR_CODES, tessellationTriangleCount } from "./contract";
export type {
  BoxInput,
  ChamferInput,
  ConeInput,
  CylinderInput,
  FilletInput,
  GeometryKernel,
  KernelBounds,
  KernelError,
  KernelErrorCode,
  KernelResult,
  MirrorInput,
  MirrorPlaneAxis,
  ProfileExtrudeInput,
  ProfileLoftInput,
  ProfileLoftSectionInput,
  ProfilePlacementInput,
  ProfileRevolveAxisInput,
  ProfileRevolveInput,
  ProfileSegmentInput,
  ProfileSweepInput,
  RotationInput,
  ShellInput,
  SphereInput,
  SweepPathSegmentInput,
  Tessellation,
  TransformInput,
  TranslationInput,
} from "./contract";
export type { KernelSolid } from "./contract";

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
export type {
  LoftSectionsProblem,
  ProfilePoint2,
  RevolveAxisFrame,
  SweepPiece,
  SweepStation,
  SweepXZ,
} from "./profile-geometry";
export type { SolidTag } from "./opaque";

export { defineKernelContractSuite } from "./contract-suite";

export {
  createKernelFeatureExecutor,
  BRIDGE_FEATURE_KINDS,
  HOLE_TOOL_OVERSHOOT_MM,
  PATTERN_COUNT_LIMIT,
  planHoleCut,
} from "./core-bridge";
export type {
  BridgeFeatureKind,
  HoleAxisSelector,
  HoleCutPlan,
  KernelExecutionBridge,
  KernelExecutorContext,
  KernelProfileResolution,
  KernelProfileResolver,
  KernelResolvedProfile,
} from "./core-bridge";

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

export {
  createNodeWorkerChannel,
  nodeWorkerThreadEcho,
} from "./node-worker-channel";
export type {
  NodeWorkerChannel,
  NodeWorkerChannelExit,
  NodeWorkerChannelOptions,
} from "./node-worker-channel";

export {
  createWebWorkerTransport,
  isWebWorkerMessagePort,
} from "./worker-web-transport";
export type { WebWorkerMessagePort } from "./worker-web-transport";

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
