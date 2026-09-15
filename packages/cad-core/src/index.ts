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
export type { ParseFailure, ParseResult } from "./result";
export { fail, ok } from "./result";
export { CAD_DOCUMENT_FORMAT_VERSION } from "./version";
