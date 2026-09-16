/**
 * Public entry of `@slopcad/cad-core`, the kernel-neutral CAD document
 * model plus the renderer-neutral render projection. This package carries
 * no React, Three.js, DOM, or geometry-kernel dependencies; every layer
 * above it — kernels, renderers, workers — builds on the API exported here.
 */
export type {
  AnyCadId,
  BodyId,
  CadId,
  CadIdKind,
  DocumentId,
  FeatureId,
  IdGenerator,
  IdGeneratorErrorCode,
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
  CadIdGeneratorExhaustedError,
  CadIdValidationError,
  createBodyId,
  createDocumentId,
  createFeatureId,
  createIdGenerator,
  createParameterId,
  createReferenceId,
  ID_ERROR_CODES,
  ID_GENERATOR_ERROR_CODES,
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
export type {
  AngleUnit,
  AnyUnit,
  AreaUnit,
  Dimension,
  DimensionlessUnit,
  LengthUnit,
  ParsedUnit,
  UnitErrorCode,
  UnitOf,
  UnitParseError,
  VolumeUnit,
} from "./units";
export {
  ANGLE_UNITS,
  AREA_UNITS,
  CANONICAL_UNITS,
  CONVERSION_TOLERANCE,
  DIMENSIONS,
  DIMENSIONLESS_UNIT,
  isAngleUnit,
  isAreaUnit,
  isDimension,
  isLengthUnit,
  isUnitToken,
  isVolumeUnit,
  LENGTH_UNITS,
  parseUnit,
  UNIT_ERROR_CODES,
  unitDimension,
  VOLUME_UNITS,
} from "./units";
export type {
  AngleValue,
  AnyDimensionalValue,
  AreaValue,
  DimensionalArithmeticFailure,
  DimensionalErrorCode,
  DimensionalOperation,
  DimensionalParseError,
  DimensionalValue,
  DimensionlessValue,
  LengthValue,
  SerializedDimensionalValue,
  VolumeValue,
} from "./dimensional";
export {
  add,
  addValues,
  angle,
  area,
  convert,
  DIMENSIONAL_ERROR_CODES,
  DimensionalArithmeticValidationError,
  dimensionless,
  DimensionalValueValidationError,
  divide,
  divideValues,
  equalQuantity,
  length,
  multiply,
  multiplyValues,
  parseDimensionalValue,
  serializeDimensionalValue,
  subtract,
  subtractValues,
  toCanonical,
  valueIn,
  volume,
} from "./dimensional";
export type {
  BinaryNode,
  BinaryOperator,
  CallNode,
  ExpressionAstError,
  ExpressionAstErrorCode,
  ExpressionFunction,
  ExpressionNode,
  ExpressionNodeKind,
  IdentifierNode,
  NumberNode,
  UnaryNode,
  UnitLiteralNode,
} from "./expression";
export {
  BINARY_OPERATORS,
  EXPRESSION_AST_ERROR_CODES,
  EXPRESSION_FUNCTIONS,
  EXPRESSION_NODE_KINDS,
  extractExpressionDependencies,
  isBinaryOperator,
  isExpressionFunction,
  isExpressionIdentifierName,
  isValidCallArity,
  MAX_EXPRESSION_DEPTH,
  MAX_EXPRESSION_IDENTIFIER_LENGTH,
  parseExpressionAst,
  printExpression,
} from "./expression";
export type {
  ExpressionParseError,
  ExpressionParseErrorCode,
} from "./expression-parser";
export {
  EXPRESSION_PARSE_ERROR_CODES,
  parseExpression,
} from "./expression-parser";
export type {
  ExpressionEnvironment,
  ExpressionEvaluationError,
  ExpressionEvaluationErrorCode,
} from "./expression-evaluator";
export {
  evaluateExpression,
  EXPRESSION_EVALUATION_ERROR_CODES,
} from "./expression-evaluator";
export type {
  Parameter,
  ParameterCollection,
  ParameterError,
  ParameterErrorCode,
  ParameterInput,
  ParameterMetadata,
  ParameterMetadataValue,
  SerializedParameter,
  SerializedParameterCollection,
} from "./parameter";
export {
  addParameter,
  EMPTY_PARAMETER_COLLECTION,
  findParameterByName,
  getParameter,
  PARAMETER_ERROR_CODES,
  parameterEnvironment,
  parseParameter,
  parseParameterCollection,
  removeParameter,
  serializeParameter,
  serializeParameterCollection,
  updateParameterExpression,
  updateParameterMetadata,
  updateParameterValue,
} from "./parameter";
export { findParameterCycle, parameterDependencyEdges } from "./parameter-graph";
export type {
  CadCommand,
  CadCommandType,
  CommandApplyError,
  CommandError,
  CommandErrorCode,
  SerializedCadCommand,
} from "./command";
export {
  applyCommand,
  CAD_COMMAND_TYPES,
  COMMAND_ERROR_CODES,
  isCadCommandType,
  parseCommand,
  serializeCommand,
} from "./command";
export type {
  CadTransaction,
  SerializedCadTransaction,
  TransactionError,
  TransactionErrorCode,
} from "./transaction";
export {
  applyTransaction,
  parseTransaction,
  serializeTransaction,
  TRANSACTION_ERROR_CODES,
} from "./transaction";
export type {
  DocumentHistory,
  HistoryEntry,
  HistoryError,
  HistoryErrorCode,
  HistoryMove,
} from "./history";
export {
  canRedo,
  canUndo,
  createDocumentHistory,
  currentDocument,
  HISTORY_ERROR_CODES,
  redoHistory,
  recordTransaction,
  undoHistory,
} from "./history";
export type { CadSession } from "./session";
export {
  applySessionCommand,
  applySessionTransaction,
  createSession,
  redoSession,
  undoSession,
} from "./session";
export type {
  FeatureGraphError,
  FeatureGraphErrorCode,
  FeatureGraphNodeId,
  FeatureGraphSourceId,
} from "./feature-graph";
export {
  affectedFeatures,
  FEATURE_GRAPH_ERROR_CODES,
  featureDependencyEdges,
  featureEvaluationOrder,
  findFeatureCycle,
} from "./feature-graph";
export type {
  Body,
  BodyAddResult,
  BodyInput,
  CadDocument,
  DocumentEntity,
  DocumentError,
  DocumentErrorCode,
  DocumentParameterAddResult,
  DocumentParameterInput,
  FeatureAddResult,
  FeatureInputKind,
  FeatureInputRef,
  FeatureRecord,
  FeatureRecordInput,
  FeatureRecordUpdate,
  FeatureUpdateResult,
  SerializedBody,
  SerializedCadDocument,
  SerializedFeatureInputRef,
  SerializedFeatureRecord,
} from "./document";
export {
  addBody,
  addDocumentParameter,
  addFeature,
  createDocument,
  DOCUMENT_ERROR_CODES,
  FEATURE_INPUT_KINDS,
  getBody,
  getDocumentEntity,
  getDocumentParameter,
  getFeature,
  parseCadDocument,
  parseFeatureInputRef,
  parseFeatureKind,
  removeBody,
  removeDocumentParameter,
  removeFeature,
  serializeCadDocument,
  updateFeature,
} from "./document";
export type {
  FeatureExecutionOutcome,
  FeatureExecutor,
  FeatureRegenerationState,
  FeatureRegenerationStatus,
  RegenerateInput,
  RegenerationError,
  RegenerationErrorCode,
  RegenerationRun,
  RegenerationStateMap,
  SerializedFeatureRegenerationStatus,
  SerializedRegenerationStateMap,
} from "./regeneration";
export {
  FEATURE_REGENERATION_STATES,
  initialRegenerationStates,
  isFeatureRegenerationState,
  markStale,
  parseRegenerationStates,
  REGENERATION_ERROR_CODES,
  regenerate,
  serializeRegenerationStates,
} from "./regeneration";
export type { ParseFailure, ParseResult } from "./result";
export { fail, ok } from "./result";
export { CAD_DOCUMENT_FORMAT_VERSION, CAD_PROJECTION_FORMAT_VERSION } from "./version";
export type {
  KernelTessellationSource,
  ProjectionError,
  ProjectionErrorCode,
  RenderBounds,
  RenderCamera,
  RenderObject,
  RenderObjectId,
  RenderProjection,
  RenderVector3,
  SerializedRenderBounds,
  SerializedRenderCamera,
  SerializedRenderObject,
  SerializedRenderProjection,
} from "./projection";
export {
  boundsFromPositions,
  createRenderObjectId,
  createRenderProjection,
  parseRenderCamera,
  parseRenderObjectId,
  parseRenderProjection,
  PROJECTION_ERROR_CODES,
  projectTessellation,
  RENDER_NORMAL_UNIT_TOLERANCE,
  RENDER_OBJECT_ID_PREFIX,
  renderObjectIdBodyId,
  serializeRenderProjection,
} from "./projection";
export type {
  CameraComparisonOptions,
  RenderObjectValidityOptions,
} from "./projection-assertions";
export {
  assertBoundsClose,
  assertCameraClose,
  assertIndicesEqual,
  assertPositionsClose,
  assertProjectionValid,
  assertRenderObjectValid,
  DEFAULT_PROJECTION_LINEAR_TOLERANCE_MM,
} from "./projection-assertions";
