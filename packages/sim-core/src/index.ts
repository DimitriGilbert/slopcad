/**
 * Public entry of `@slopcad/sim-core`, the simulation data spine
 * (ROADMAP-SIM Phase 61): scenario compilation at the S4 units boundary,
 * the S9 regime-honesty numbers, the starter fluid property set, the
 * scenario-snapshot hash, the SimResult model with its deterministic
 * binary payload and exporters, the SimEngine provider contract, and —
 * Phase 61b — the `sim.*` worker vocabulary over the kernel-envelope
 * discipline, including the progress/field-chunk notification class and
 * the deterministic fake engine that exercises every protocol path until
 * the real solvers land. Phase 61c adds the SimResultStore (law S7): the
 * run-record wire contract with its parsers, the server and local
 * first-class backends, and the backend-selection seam. Phase 62a adds
 * law S3's geometry interface: the voxelizer (tessellation → occupancy
 * grid, 3D and cross-section slices), the signed-distance field behind
 * its own optional door, and the named-grid semantics that ride the
 * SimResult field blocks so overlays decode them through the existing
 * payload path. Phase 63c adds the geometry-aware compile door
 * (`./compile-geometry`: the tessellation's voxelized occupancy slice and
 * the flow-run controls inside the compiled problem) and the decimated
 * `.vti` export twin (`./export-vtk`). The package
 * carries zero runtime dependencies, no
 * React, no DOM, and no solver — everything above it (sim-flow,
 * sim-dynamics, the worker host) builds on the API exported here.
 *
 * The worker machinery deliberately RESTATES the kernel protocol's
 * disciplines (envelope, ids, wire errors, cancellation ledger,
 * transports, boot) with their wire values pinned equal — the semantic
 * authority is `@slopcad/cad-kernel`'s worker modules, and a
 * cross-compatibility test in this package fails on drift.
 *
 * NOTE: the Node-only hosting modules (`./sim-node-worker` — the
 * `node:worker_threads` channel factory — and the `./sim-worker.node`
 * entry) are deliberately NOT re-exported here: the runtime index must
 * stay importable by browsers/consumers without node builtins. Import
 * them from the `@slopcad/sim-core/sim-node-worker` subpath instead (the
 * Node-side worker tests do). The browser entry (`./sim-worker.web`) is
 * likewise a subpath-only module — apps re-host it through a relative
 * entry file for bundler URL resolution.
 */

export {
  SIM_ERROR_CODES,
  simError,
  type SimError,
  type SimErrorCode,
} from "./errors";
export {
  simFail,
  simOk,
  type SimParseFailure,
  type SimParseResult,
} from "./result";
export {
  SIM_CORE_DOMAIN_FACES,
  SIM_CORE_SCENARIO_KINDS,
  type SimDomainFace,
  type SimScenarioKind,
  isSimScenarioKind,
} from "./vocabulary";
export {
  type SimFluidProperties,
  type SimFluidPropertyFit,
  type SimFluidState,
  SIM_FLUIDS,
  SIM_FLUID_AIR,
  SIM_FLUID_GLYCOL,
  SIM_FLUID_WATER,
  evaluateSimFluidFit,
  getSimFluid,
  simFluidState,
} from "./fluids";
export {
  type SimQualitativeFlag,
  type SimRegimeInputs,
  type SimRegimeReport,
  SIM_QUALITATIVE_FLAGS,
  SIM_REGIME_THRESHOLDS,
  simMach,
  simPrandtl,
  simRayleigh,
  simRegimeReport,
  simReynolds,
} from "./regime";
export { canonicalSimJson, simScenarioSnapshotHash } from "./snapshot";
export {
  type CompiledSimRunControls,
  type GeometrySimCompileInput,
  SIM_FLOW_DEFAULT_STEP_BUDGET,
  compileSimScenarioWithGeometry,
} from "./compile-geometry";
export {
  type CompiledSimCondition,
  type CompiledSimMotor,
  type CompiledSimMotorLine,
  type CompiledSimMotorTable,
  type CompiledSimScenario,
  type SimBodyBoundsMm,
  type SimCompileInput,
  type SimProjectedField,
  type SimProjectedOutcome,
  type SimProjectedQuantity,
  SIM_PROJECTION_UNITS,
  SIM_QUANTITY_DIMENSIONS,
  type SimQuantityDimension,
  type SolverSimField,
  type SolverSimOutcome,
  type SolverSimScalar,
  MM_PER_M,
  compileSimScenario,
  projectSimResult,
} from "./units";
export {
  type SimHistorySeries,
  type SimResult,
  type SimResultFieldBlock,
  type SimResultStatus,
  type SimResultSummary,
  type SimServedBackend,
  SIM_FIELD_LABEL_MAX_BYTES,
  SIM_RESULT_PAYLOAD_VERSION,
  SIM_RESULT_STATUSES,
  SIM_RESULT_SUMMARY_VERSION,
  decodeSimResultPayload,
  encodeSimResultPayload,
} from "./sim-result";
export {
  type SimHistoryColumn,
  type SimHistoryTable,
  exportSimHistoryCsv,
} from "./export-csv";
export {
  type SimResultPutWireInput,
  type SimResultRunRecord,
  type SimResultRunWire,
  type SimResultServerClient,
  type SimResultStore,
  type SimResultStoreBackend,
  type SelectSimResultStoreOptions,
  type SimStoredResult,
  SIM_HISTORY_MAX_SAMPLES,
  SIM_RESULT_LABEL_MAX_LENGTH,
  SIM_RESULT_MAX_HISTORIES,
  SIM_RESULT_RUN_ID_MAX_LENGTH,
  SIM_RESULT_STORE_BACKENDS,
  SIM_RESULT_SUMMARY_MAX_QUANTITIES,
  decodeSimResultRunWire,
  encodeSimResultPutWireInput,
  groupSimResultRunsBySnapshotHash,
  parseSimHistorySeriesList,
  parseSimResultRunRecord,
  parseSimResultSummary,
  selectSimResultStore,
} from "./sim-result-store";
export {
  type LocalSimResultStoreOptions,
  type SimResultStorage,
  type SimResultStorageRecord,
  createInMemorySimResultStorage,
  createLocalSimResultStore,
  createSimResultRunIdMinter,
} from "./sim-result-store-local";
export {
  type ServerSimResultStoreOptions,
  createServerSimResultStore,
} from "./sim-result-store-server";
export {
  type SimIdbDatabase,
  type SimIdbFactory,
  type SimIdbObjectStore,
  type SimIdbOpenRequest,
  type SimIdbRequest,
  type SimIdbTransaction,
  createIndexedDbSimResultStorage,
} from "./sim-result-store-idb";
export {
  SIM_VTI_MAX_DECIMATION,
  decimateSimFieldBlock,
  exportSimFieldVti,
  exportSimFieldVtiDecimated,
} from "./export-vtk";
export {
  type SimEngine,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimEngineRequest,
} from "./engine";
export {
  FAKE_SIM_ENGINE,
  FAKE_SIM_ENGINE_CHUNK_ROUNDS,
  FAKE_SIM_ENGINE_FIELD_CHUNKS,
  FAKE_SIM_ENGINE_ID,
  FAKE_SIM_ENGINE_STEPS,
  createFakeSimEngine,
} from "./fake-engine";
export {
  decodeSimFieldChunkValues,
  encodeSimFieldChunkValues,
  reassembleSimFieldChunks,
  SIM_FIELD_CHUNK_MAX_VALUES,
  splitSimFieldBlock,
} from "./sim-field-chunks";
export { decodeSimBase64Strict, encodeSimBase64 } from "./sim-base64";
export {
  isSimWorkerErrorCode,
  parseSimWorkerError,
  toSimWorkerError,
  simWorkerError,
  simWorkerParseError,
  SIM_WORKER_PROTOCOL_ERROR_CODES,
} from "./sim-worker-errors";
export type {
  SimWorkerError,
  SimWorkerErrorDataValue,
  SimWorkerErrorCode,
  SimWorkerParseError,
} from "./sim-worker-errors";
export {
  createSimWorkerIdGenerator,
  createSimWorkerRequestId,
  parseSimProblemId,
  parseSimRunId,
  parseSimWorkerRequestId,
  SIM_WORKER_ID_KINDS,
  SIM_WORKER_ID_MAX_PAYLOAD_LENGTH,
  SIM_WORKER_ID_PREFIXES,
} from "./sim-worker-ids";
export type {
  SimProblemId,
  SimRunId,
  SimWorkerId,
  SimWorkerIdGenerator,
  SimWorkerIdGeneratorState,
  SimWorkerIdKind,
  SimWorkerRequestId,
} from "./sim-worker-ids";
export {
  isSimWorkerOperationId,
  parseSimWorkerOperationInput,
  parseSimWorkerOperationResult,
  serializeSimWorkerOperationInput,
  serializeSimWorkerOperationResult,
  simResultToFinalizeResult,
  SIM_WORKER_OPERATION_IDS,
} from "./sim-worker-operations";
export type {
  SerializedCompiledSimScenario,
  SerializedSimBodyBounds,
  SerializedSimCondition,
  SerializedSimWorkerOperationInput,
  SerializedSimWorkerOperationInputs,
  SerializedSimWorkerOperationResult,
  SerializedSimWorkerOperationResults,
  SimWorkerOperationId,
  SimWorkerOperationInput,
  SimWorkerOperationInputs,
  SimWorkerOperationResult,
  SimWorkerOperationResults,
  WorkerSimCompileInput,
  WorkerSimCompileResult,
  WorkerSimFinalizeInput,
  WorkerSimFinalizeResult,
  WorkerSimRunInput,
  WorkerSimRunResult,
} from "./sim-worker-operations";
export {
  createSimFieldChunkNotification,
  createSimProgressNotification,
  createSimWorkerCancel,
  createSimWorkerErrorResponse,
  createSimWorkerRequest,
  createSimWorkerSuccessResponse,
  decodeSimWorkerNotification,
  decodeSimWorkerRequest,
  decodeSimWorkerResult,
  parseSimWorkerMessage,
  SIM_WORKER_MESSAGE_KINDS,
  SIM_WORKER_PROTOCOL_VERSION,
} from "./sim-worker-protocol";
export type {
  DecodedSimWorkerRequest,
  SerializedSimFieldChunkNotification,
  SerializedSimProgressNotification,
  SerializedSimWorkerNotification,
  SimFieldChunkNotification,
  SimNotificationDelivery,
  SimProgressNotification,
  SimWorkerCancelMessage,
  SimWorkerErrorResponseMessage,
  SimWorkerMessage,
  SimWorkerMessageKind,
  SimWorkerNotification,
  SimWorkerNotificationMessage,
  SimWorkerRequestMessage,
  SimWorkerResponseMessage,
  SimWorkerSuccessResponseMessage,
} from "./sim-worker-protocol";
export { createSimWorkerCancellationLedger } from "./sim-worker-cancellation";
export type {
  SimWorkerCancellationFinishDecision,
  SimWorkerCancellationLedger,
  SimWorkerCancellationRecordOutcome,
  SimWorkerCancellationStartDecision,
} from "./sim-worker-cancellation";
export { createSimInMemoryTransportPair } from "./sim-transport";
export type {
  SimInMemoryWorkerTransportPair,
  SimWorkerTransport,
} from "./sim-transport";
export { createSimNodeWorkerTransport } from "./sim-node-transport";
export type { SimNodeWorkerMessagePort } from "./sim-node-transport";
export {
  createSimWebWorkerTransport,
  isSimWebWorkerMessagePort,
} from "./sim-web-transport";
export type { SimWebWorkerMessagePort } from "./sim-web-transport";
export { createSimWorkerServer } from "./sim-worker-server";
export type {
  SimWorkerServer,
  SimWorkerServerOptions,
} from "./sim-worker-server";
export { createSimWorkerClient, SimRequestFailure } from "./sim-worker-client";
export type {
  SimWorkerClient,
  SimWorkerClientOptions,
} from "./sim-worker-client";
export {
  parseSimWorkerBootFailureReport,
  SIM_WORKER_BOOT_FAILURE_KEY,
} from "./sim-boot-failure-report";
export type { SimWorkerBootFailureReport } from "./sim-boot-failure-report";
export { bootSimWorkerChannel } from "./sim-worker-boot";
export type {
  BootedSimWorkerChannel,
  SimWorkerBootFailure,
  SimWorkerCrashPort,
} from "./sim-worker-boot";
export { hostSimWorker } from "./sim-worker";
export type { SimWorkerHostOptions } from "./sim-worker";
export {
  type SimDistanceGrid,
  type SimGridFieldSemantic,
  type SimGridGeometry,
  type SimOccupancyGrid,
  type SimVoxelGrid,
  SIM_GRID_FIELD_SEMANTICS,
  SIM_GRID_MAX_SAMPLES,
  SIM_GRID_NAME_MAX_LENGTH,
  parseSimGridFieldId,
  simGridFieldId,
  simGridFromFieldBlock,
  simGridGeometryProblem,
  simGridNameProblem,
  simGridSampleCount,
  simGridSamplePositionM,
  simGridSolverField,
  simGridToFieldBlock,
} from "./voxel-grid";
export {
  type SimTessellationWire,
  type SimVoxelDomain,
  type SimVoxelDomainBody,
  type SimVoxelDomainExplicit,
  type SimVoxelPlaneAxis,
  type SimVoxelizeInput,
  type SimVoxelizeSliceInput,
  type SimVoxelSlicePlane,
  type ValidatedSimTessellation,
  SIM_VOXEL_PLANE_AXES,
  parseSimTessellationWire,
  simTessellationBoundsMm,
  voxelizeSimTessellation,
  voxelizeSimTessellationSlice,
} from "./voxelizer";
export {
  type SimSignedDistanceInput,
  simSignedDistanceGrid,
} from "./signed-distance";
