/**
 * Public entry of `@slopcad/cad-core`, the kernel-neutral CAD document
 * model. This package carries no React, Three.js, DOM, or geometry-kernel
 * dependencies; every layer above it builds on the API exported here.
 */
export type {
  AnyCadId,
  BodyId,
  CadId,
  CadIdKind,
  DocumentId,
  FeatureId,
  IdGenerator,
  IdGeneratorState,
  IdParseError,
  ParameterId,
  ParsedCadId,
  ReferenceId,
} from "./ids";
export {
  CAD_ID_KINDS,
  CAD_ID_MAX_PAYLOAD_LENGTH,
  CAD_ID_PREFIXES,
  CadIdValidationError,
  createBodyId,
  createDocumentId,
  createFeatureId,
  createIdGenerator,
  createParameterId,
  createReferenceId,
  ID_ERROR_CODES,
  parseAnyCadId,
  parseBodyId,
  parseDocumentId,
  parseFeatureId,
  parseParameterId,
  parseReferenceId,
} from "./ids";
export type {
  Diagnostic,
  DiagnosticCode,
  DiagnosticDataValue,
  DiagnosticLocation,
  DiagnosticParseError,
  DiagnosticParseErrorCode,
  DiagnosticSeverity,
} from "./diagnostics";
export {
  compareSeverities,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SEVERITY_ORDER,
  isDiagnosticCode,
  isDiagnosticSeverity,
  parseDiagnostic,
} from "./diagnostics";
export type { ParseFailure, ParseResult } from "./result";
export { fail, ok } from "./result";
export { CAD_DOCUMENT_FORMAT_VERSION } from "./version";
