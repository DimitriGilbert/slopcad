/**
 * Public entry of `@slopcad/cad-sketch`, the 2D parametric sketch domain
 * (Phase 24). It depends only on `@slopcad/cad-core` (branded-id conventions,
 * ParseResult, dimensional values) and owns the sketch substrate later
 * phases build on: workplanes, entities, constraints, serialization, and a
 * solver-neutral solving contract with a deterministic reference
 * implementation. No solver internals cross this surface — results are
 * solved parameters, degrees of freedom, and structured `sketch/*`
 * diagnostics only.
 */

export {
  SKETCH_ID_KINDS,
  SKETCH_ID_MAX_PAYLOAD_LENGTH,
  SKETCH_ID_PREFIXES,
  SKETCH_ID_ERROR_CODES,
  SKETCH_ID_GENERATOR_ERROR_CODES,
  SketchIdGeneratorExhaustedError,
  SketchIdValidationError,
  createSketchConstraintId,
  createSketchEntityId,
  createSketchIdGenerator,
  parseAnySketchId,
  parseSketchConstraintId,
  parseSketchEntityId,
} from "./sketch-ids";
export type {
  SketchConstraintId,
  SketchEntityId,
  SketchId,
  SketchIdGeneratorState,
  SketchIdKind,
} from "./sketch-ids";

export {
  SKETCH_DIAGNOSTIC_CODES,
  isSketchDiagnosticCode,
  parseSketchDiagnostic,
  sketchDiagnostic,
} from "./diagnostics";
export type {
  AnySketchId,
  SketchDiagnostic,
  SketchDiagnosticCode,
  SketchDiagnosticDataValue,
  SketchDiagnosticLocation,
  SketchDiagnosticParseError,
} from "./diagnostics";

export {
  WORKPLANE_DIRECTION_EPSILON,
  WORKPLANE_ORTHONORMALITY_TOLERANCE,
  createWorkplane,
  frontWorkplane,
  orthonormalizeWorkplane,
  parseWorkplane,
  serializeWorkplane,
  worldToWorkplane,
  workplaneBasis,
  workplaneToWorld,
  xyWorkplane,
} from "./workplane";
export type {
  SerializedWorkplane,
  Vec3,
  Workplane,
  WorkplaneError,
} from "./workplane";

export {
  SKETCH_ENTITY_KINDS,
  SketchEntityValidationError,
  arcSweep,
  createArcEntity,
  createCircleEntity,
  createLineEntity,
  createPointEntity,
  createRectangleEntity,
  isSketchEntityKind,
  parseSketchEntity,
  serializeSketchEntity,
} from "./entities";
export type {
  ArcEntity,
  CircleEntity,
  EntityOptions,
  LineEntity,
  PointEntity,
  RectangleEntity,
  SerializedSketchEntity,
  SketchEntity,
  SketchEntityError,
  SketchEntityKind,
} from "./entities";

export {
  SKETCH_CONSTRAINT_KINDS,
  SketchConstraintValidationError,
  TANGENT_VARIANTS,
  createAngleConstraint,
  createCoincidentConstraint,
  createDiameterConstraint,
  createDistanceConstraint,
  createEqualConstraint,
  createHorizontalConstraint,
  createMidpointConstraint,
  createParallelConstraint,
  createPerpendicularConstraint,
  createRadiusConstraint,
  createSymmetryAboutLineConstraint,
  createSymmetryAboutPointConstraint,
  createTangentConstraint,
  createVerticalConstraint,
  isSketchConstraintKind,
  isTangentVariant,
  parseSketchConstraint,
  pointTarget,
  serializeSketchConstraint,
  validateConstraintReferences,
} from "./constraints";
export type {
  AngleConstraint,
  CoincidentConstraint,
  DiameterConstraint,
  DistanceConstraint,
  EqualConstraint,
  HorizontalConstraint,
  MidpointConstraint,
  ParallelConstraint,
  PerpendicularConstraint,
  PointTarget,
  RadiusConstraint,
  SketchConstraint,
  SketchConstraintError,
  SketchConstraintKind,
  SymmetryAbout,
  SymmetryConstraint,
  TangentConstraint,
  TangentVariant,
  VerticalConstraint,
} from "./constraints";

export {
  SKETCH_FORMAT_VERSION,
  applySolvedParameters,
  createSketch,
  parseSketch,
  serializeSketch,
} from "./sketch";
export type { SerializedSketch, Sketch, SketchError } from "./sketch";

export {
  DIMENSIONAL_CONSTRAINT_KINDS,
  SKETCH_COMMAND_ERROR_CODES,
  SKETCH_COMMAND_TYPES,
  applySketchCommand,
  applySketchTransaction,
  isDimensionalConstraint,
  isDimensionalConstraintKind,
  isSketchCommandType,
  parseSketchCommand,
  serializeSketchCommand,
} from "./commands";
export type {
  DimensionalConstraint,
  DimensionalConstraintKind,
  SerializedSketchCommand,
  SketchCommand,
  SketchCommandError,
  SketchCommandErrorCode,
  SketchCommandType,
  SketchTransaction,
} from "./commands";

export {
  applySketchSessionTransaction,
  canRedoSketch,
  canUndoSketch,
  createSketchSession,
  redoSketchSession,
  undoSketchSession,
} from "./sketch-session";
export type {
  SketchHistory,
  SketchHistoryEntry,
  SketchHistoryMove,
  SketchSession,
} from "./sketch-session";

export {
  REFERENCE_SKETCH_SOLVER_ID,
  REFERENCE_SOLVER_CONVERGENCE_TOLERANCE,
  REFERENCE_SOLVER_MAX_BACKTRACK,
  REFERENCE_SOLVER_MAX_ITERATIONS,
  REFERENCE_SOLVER_PIVOT_TOLERANCE,
  REFERENCE_SOLVER_RANK_TOLERANCE,
  REFERENCE_SOLVER_STAGNATION_TOLERANCE,
  createReferenceSketchSolver,
} from "./reference-solver";

export type {
  SketchSolveResult,
  SketchSolver,
  SolvedEntityParameters,
  SolvedSketchParameters,
} from "./solver";
export { solvedEntityParametersById } from "./solver";

export {
  arcChainSketch,
  conflictingDimensionsSketch,
  dimensionedRectangleSketch,
  fullyConstrainedTriangleSketch,
  redundantConstraintSketch,
  symmetricPatternSketch,
  tangentChainSketch,
  unsatisfiableChainSketch,
} from "./sketch-fixtures";

export {
  PROFILE_ENDPOINT_TOLERANCE_MM,
  PROFILE_MIN_AREA_MM2,
  profileLoopSignedArea,
  resolveExtrudeProfile,
  resolveProfileLoops,
} from "./profile";
export type {
  ProfileError,
  ProfileLoop,
  ProfilePoint,
  ProfileSegment,
  ResolvedProfile,
} from "./profile";
export { workplaneToPlacement } from "./workplane-placement";
export type {
  PlacementAxis,
  WorkplanePlacement,
  WorkplanePlacementRotation,
} from "./workplane-placement";
