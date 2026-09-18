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
  SketchDocumentId,
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
  parseSketchDocumentId,
  createSketchDocumentId,
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
export {
  findParameterCycle,
  parameterDependencyEdges,
} from "./parameter-graph";
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
  FeatureHistoryError,
  FeatureHistoryErrorCode,
  FeatureRollbackPoint,
  FeatureTimelineEntry,
  FeatureTimelineEntryDiagnostic,
  FeatureTimelineInput,
  FeatureTimelineStatus,
} from "./feature-history";
export {
  documentChangeInvalidations,
  FEATURE_HISTORY_ERROR_CODES,
  FEATURE_TIMELINE_STATUSES,
  featureTimeline,
  isFeatureTimelineStatus,
  parseFeatureRollbackShape,
  reorderFeatureRecords,
  rollbackZoneBoundary,
} from "./feature-history";
export type {
  Body,
  BodyAddResult,
  BodyInput,
  CadDocument,
  DocumentEntity,
  DocumentReference,
  DocumentReferenceAddResult,
  DocumentReferenceInput,
  DocumentSketch,
  DocumentSketchInput,
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
  getDocumentSketch,
  addDocumentSketch,
  removeDocumentSketch,
  getDocumentReference,
  addDocumentReference,
  removeDocumentReference,
  getDocumentParameter,
  getFeature,
  parseCadDocument,
  parseFeatureInputRef,
  parseFeatureKind,
  removeBody,
  removeDocumentParameter,
  removeFeature,
  reorderFeature,
  serializeCadDocument,
  updateFeature,
} from "./document";
export type {
  FeatureExecutionOutcome,
  FeatureExecutionRecord,
  FeatureExecutor,
  FeatureRegenerationState,
  FeatureRegenerationStatus,
  RegenerateInput,
  RegenerationError,
  RegenerationErrorCode,
  RegenerationResultMap,
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
export {
  CAD_DOCUMENT_FORMAT_VERSION,
  CAD_NATIVE_FORMAT_VERSION,
  CAD_PROJECTION_FORMAT_VERSION,
} from "./version";
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
export type {
  EdgeSelectionReference,
  FaceSelectionReference,
  SelectionCategory,
  SelectionError,
  SelectionErrorCode,
  SelectionReference,
  SelectionState,
  SerializedSelectionReference,
  SerializedSelectionState,
  SolidSelectionReference,
  StableSelectionKind,
  StableSelectionReference,
  SyntheticSelectionKind,
  SyntheticSelectionReference,
  VertexSelectionReference,
} from "./selection";
export {
  beginRegeneration,
  clearSelection,
  createSelectionState,
  hoverSelection,
  isSyntheticSelectionReference,
  parseSelectionReference,
  parseSelectionState,
  pickSelection,
  SELECTION_CATEGORIES,
  SELECTION_ERROR_CODES,
  selectionReferenceBodyId,
  selectionReferenceKey,
  serializeSelectionReference,
  serializeSelectionState,
  STABLE_SELECTION_KINDS,
  SYNTHETIC_SELECTION_KINDS,
} from "./selection";
export type { SyntheticFace, SyntheticFaceGrouping } from "./synthetic-faces";
export {
  groupSyntheticFaces,
  syntheticFaceAnchor,
  syntheticFaceMeanNormal,
  syntheticFaceOfTriangle,
  SYNTHETIC_FACE_GROUPING_THRESHOLD_DEGREES,
} from "./synthetic-faces";
export type {
  MintReferenceOptions,
  PersistentEntityReference,
  ReferenceAnchor,
  ReferenceError,
  ReferenceErrorCode,
  ReferenceInvalidReason,
  ReferenceProvenance,
  ReferenceRepairRecord,
  ReferenceRepairStrategy,
  ReferenceValidity,
  ReferenceValidityRecord,
  ReferenceVector3,
  RepairReferenceOptions,
  ResolveReferenceOptions,
  SerializedReferenceAnchor,
  SerializedReferenceProvenance,
  SerializedReferenceRepairRecord,
  SerializedReferenceValidityRecord,
  SerializedTopologyEntityReference,
  SerializedTopologyGeometryDescriptor,
  SerializedTopologyIdentityPayload,
  TopologyEntityReference,
  TopologyEntitySnapshot,
  TopologyGeometryDescriptor,
  TopologyIdentityDatum,
  TopologyIdentityPayload,
  TopologyReferenceKind,
  TopologySnapshot,
  TopologyView,
  TransientSelectionReference,
} from "./persistent-reference";
export {
  applyReferenceValidity,
  disambiguateTopologyReference,
  isReferenceInvalidReason,
  isReferenceRepairStrategy,
  isReferenceValidity,
  mintTopologyReference,
  parseTopologyReference,
  provenanceIntact,
  REFERENCE_ERROR_CODES,
  REFERENCE_INVALID_REASONS,
  REFERENCE_MEASURE_RELATIVE_TOLERANCE,
  REFERENCE_POSITION_TOLERANCE_MM,
  REFERENCE_REPAIR_STRATEGIES,
  REFERENCE_VALIDITY_STATES,
  referenceProvenance,
  repairTopologyReference,
  resolveDocumentReference,
  resolveTopologyReference,
  serializeTopologyReference,
  TOPOLOGY_REFERENCE_KINDS,
  topologyGeometryMatches,
  topologyIdentityPayloadEqual,
  transientSelectionOf,
} from "./persistent-reference";
export type {
  ToolEventError,
  ToolEventErrorCode,
  ToolEventType,
  ToolInputEvent,
  ToolKeyboardEvent,
  ToolModifiers,
  ToolPick,
  ToolPointerEvent,
  ToolPointerEventType,
} from "./tool-events";
export {
  NO_TOOL_MODIFIERS,
  parseToolInputEvent,
  TOOL_EVENT_ERROR_CODES,
  TOOL_EVENT_TYPES,
  TOOL_POINTER_EVENT_TYPES,
  toolModifiers,
} from "./tool-events";
export type {
  ToolContext,
  ToolRuntime,
  ToolRuntimeOptions,
  ToolSelectionOperation,
} from "./tool-context";
export { createToolRuntime } from "./tool-context";
export type {
  CadTool,
  ToolCompletion,
  ToolCompletionDetail,
  ToolFailure,
  ToolFailureCode,
  ToolManager,
  ToolManagerOptions,
  ToolManagerPhase,
  ToolRegistryEntry,
  ToolStateBase,
  ToolTransition,
} from "./tool-manager";
export {
  createToolManager,
  registerTool,
  TOOL_FAILURE_CODES,
  TOOL_MANAGER_PHASES,
  toolFailure,
} from "./tool-manager";
export type { SelectToolState } from "./tool-select";
export { SELECT_TOOL_ID, selectTool } from "./tool-select";
export type { MeasureToolState } from "./tool-measure";
export { MEASURE_TOOL_ID, measureTool } from "./tool-measure";
export type { TranslateTarget, TranslateToolState } from "./tool-translate";
export {
  resolveTranslateTarget,
  TRANSLATE_FEATURE_KIND,
  TRANSLATE_TOOL_ID,
  translateTool,
} from "./tool-translate";
export type { RotateTarget, RotateToolState } from "./tool-rotate";
export {
  bodyBoundsCenter,
  resolveRotateTarget,
  ROTATE_FEATURE_KIND,
  ROTATE_TOOL_ID,
  rotateTool,
  sweptAngleAboutZ,
} from "./tool-rotate";
export type {
  NativeFormatMigration,
  NativeMigrationError,
  NativeMigrationErrorCode,
} from "./native-migration";
export {
  migrateNativeCadDocument,
  NATIVE_FORMAT_MIGRATIONS,
  NATIVE_MIGRATION_ERROR_CODES,
  planNativeFormatMigrations,
  readNativeFormatVersion,
  runNativeFormatMigrations,
} from "./native-migration";
export type {
  NativeCadDocument,
  NativeCadDocumentParseError,
  NativeDocumentValidation,
  NativeFormatError,
  NativeFormatErrorCode,
  NativeFormatIssue,
  NativeFormatIssueCode,
  SerializedFeatureRollbackPoint,
  SerializedNativeCadDocument,
  SerializedNativeHistory,
} from "./native-format";
export {
  createNativeCadDocument,
  encodeNativeCadDocument,
  NATIVE_FORMAT_ERROR_CODES,
  NATIVE_FORMAT_ISSUE_CODES,
  parseNativeCadDocument,
  parseNativeCadDocumentFromBytes,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  validateNativeCadDocument,
} from "./native-format";
export {
  boundsExtents,
  formatBoundsExtents,
  selectedBoundsBody,
} from "./bounds";
export type { MassProperties } from "./mass-properties";
export {
  formatMassProperties,
  formatSurfaceArea,
  formatVolume,
  massPropertiesOf,
} from "./mass-properties";
export type {
  DistanceError,
  DistanceErrorCode,
  MeasureEntity,
} from "./distance";
export {
  DISTANCE_ERROR_CODES,
  edgeEntity,
  formatMeasureDistance,
  measureDistance,
  measureEntityOfReference,
  measureEntityOfSnapshotEntity,
  measureSurfaceOfSyntheticFace,
  pointEntity,
  selectionDistance,
  surfaceEntity,
  surfaceOfRenderObject,
  vertexEntity,
} from "./distance";
export type {
  RadiusError,
  RadiusErrorCode,
  RadiusFitDetails,
  RadiusMeasure,
  RadiusPrecision,
} from "./radius";
export {
  fitCylindricalRadius,
  formatRadiusMeasure,
  RADIUS_ERROR_CODES,
  RADIUS_FIT_MAX_RESIDUAL_MM,
  selectionRadius,
  snapshotEntityRadius,
  storedRadius,
} from "./radius";
