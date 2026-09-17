/**
 * Public entry of `@slopcad/cad-kernel-occt`, the OpenCascade geometry
 * kernel adapter (Phase 21.1). It depends only on the kernel abstraction,
 * cad-core's dimensional values, and the OpenCascade runtime — never on
 * React or UI. No OpenCascade type crosses this surface: the runtime handle
 * is opaque, and geometry travels exclusively as kernel-neutral solids and
 * measurements. The binding's own WASM artifact is ~22 MB and its heap has
 * a 100 MB floor, so the package is deliberately optional — nothing in the
 * app graph pulls it in until a caller chooses the `opencascade` backend.
 */

export { OCCT_BACKEND_ID } from "./occt-backend";

export {
  OCCT_KERNEL_CAPABILITIES,
  OCCT_TESSELLATION_ANGULAR_TOLERANCE_RAD,
  OCCT_TESSELLATION_LINEAR_DEFLECTION_MM,
  createOcctKernel,
  occtKernelFromRuntime,
} from "./occt-kernel";
export type {
  ImportedBrepModel,
  ImportedBrepSolid,
  ImportedStepModel,
  ImportedStepSolid,
  OcctKernel,
  OcctTopologySnapshotOptions,
} from "./occt-kernel";

export {
  OCCT_SHAPE_HASH_UPPER_BOUND,
  OCCT_TOPOLOGY_DEFAULT_KINDS,
  OCCT_TOPOLOGY_IDENTITY_SCHEMAS,
  OCCT_TOPOLOGY_IDENTITY_SCHEMA,
  occtTopologyView,
} from "./occt-topology";
export type {
  OcctTopologyViewOptions,
} from "./occt-topology";

export { BREP_EXPORT_ERROR_CODES, BREP_IMPORT_ERROR_CODES } from "./occt-brep";
export type {
  BrepExportError,
  BrepExportErrorCode,
  BrepImportError,
  BrepImportErrorCode,
} from "./occt-brep";

export {
  createIgesEngine,
  IGES_IMPORT_ERROR_CODES,
  importIgesMeshes,
} from "./occt-iges-import";
export type {
  IgesEngine,
  IgesImportError,
  IgesImportErrorCode,
  IgesImportParams,
  ImportedIgesMesh,
  ImportedIgesModel,
} from "./occt-iges-import";

export { STEP_IMPORT_ERROR_CODES } from "./occt-step-import";
export type { StepImportError, StepImportErrorCode } from "./occt-step-import";

export {
  STEP_EXPORT_EPOCH_STAMP,
  STEP_EXPORT_ERROR_CODES,
  STEP_EXPORT_SCHEMAS,
  STEP_EXPORT_UNITS,
} from "./occt-step-export";
export type {
  StepExportError,
  StepExportErrorCode,
  StepExportOptions,
  StepExportSchema,
  StepExportUnit,
} from "./occt-step-export";

export {
  buildBooleanChain,
  buildPlateWithHole,
  BOOLEAN_CHAIN,
  PLATE_WITH_HOLE,
} from "./occt-fixtures";
export type {
  BooleanChainFixture,
  PlateWithHoleFixture,
} from "./occt-fixtures";

export { createOcctRuntime } from "./occt-runtime";
export type { OcctRuntime } from "./occt-runtime";
