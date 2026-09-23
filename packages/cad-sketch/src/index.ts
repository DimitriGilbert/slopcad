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
  POLYGON_FITS,
  POLYGON_MAX_SIDES,
  POLYGON_MIN_SIDES,
  SKETCH_ENTITY_KINDS,
  SLOT_VARIANTS,
  SPLINE_FLAVORS,
  SketchEntityValidationError,
  arcSweep,
  circumcircleOf,
  createArc3SlotEntity,
  createArcEntity,
  createCircleEntity,
  createEllipseEntity,
  createEllipticalArcEntity,
  createLineEntity,
  createPointEntity,
  createPolygonEntity,
  createRectangleEntity,
  createSplineEntity,
  createStraightSlotEntity,
  isPolygonFit,
  isSketchEntityKind,
  isSlotVariant,
  isSplineFlavor,
  parseSketchEntity,
  serializeSketchEntity,
  slotEndPoint,
  slotStartPoint,
} from "./entities";
export type {
  ArcEntity,
  CircleEntity,
  EllipseEntity,
  EllipticalArcEntity,
  EntityOptions,
  LineEntity,
  PointEntity,
  PolygonEntity,
  PolygonFit,
  RectangleEntity,
  SerializedSketchEntity,
  SketchEntity,
  SketchEntityError,
  SketchEntityKind,
  SlotEntity,
  SlotVariant,
  SplineEntity,
  SplineFlavor,
  SplinePoint,
} from "./entities";

export {
  SKETCH_CONSTRAINT_KINDS,
  SPLINE_END_SELECTIONS,
  SketchConstraintValidationError,
  TANGENT_VARIANTS,
  createAngleConstraint,
  createCoincidentConstraint,
  createCollinearConstraint,
  createDiameterConstraint,
  createDistanceConstraint,
  createDistanceXConstraint,
  createDistanceYConstraint,
  createEqualConstraint,
  createHorizontalConstraint,
  createHorizontalPairConstraint,
  createMidpointConstraint,
  createParallelConstraint,
  createPerpendicularConstraint,
  createPointOnEntityConstraint,
  createPointOnTangentConstraint,
  createRadiusConstraint,
  createSymmetryAboutLineConstraint,
  createSymmetryAboutPointConstraint,
  createTangentConstraint,
  createVerticalConstraint,
  createVerticalPairConstraint,
  isSketchConstraintKind,
  isSplineEndSelection,
  isTangentVariant,
  parseSketchConstraint,
  pointTarget,
  serializeSketchConstraint,
  validateConstraintReferences,
} from "./constraints";
export type {
  AngleConstraint,
  CoincidentConstraint,
  CollinearConstraint,
  DiameterConstraint,
  DistanceConstraint,
  DistanceXConstraint,
  DistanceYConstraint,
  EqualConstraint,
  HorizontalConstraint,
  HorizontalPairConstraint,
  MidpointConstraint,
  ParallelConstraint,
  PerpendicularConstraint,
  PointOnEntityConstraint,
  PointOnTangentConstraint,
  PointTarget,
  RadiusConstraint,
  SketchConstraint,
  SketchConstraintError,
  SketchConstraintKind,
  SplineEndSelection,
  SymmetryAbout,
  SymmetryConstraint,
  TangentConstraint,
  TangentVariant,
  VerticalConstraint,
  VerticalPairConstraint,
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
  CHAIN_CONTACT_EPSILON_MM,
  OFFSET_COLLAPSE_EPSILON_MM,
  SKETCH_ENTITY_OP_ERROR_CODES,
  circularArrayCommands,
  createSketchOpIdAllocator,
  extendLineCommand,
  mirrorEntitiesCommands,
  offsetEntitiesCommands,
  rectangularArrayCommands,
  translateSketchEntity,
} from "./entity-ops";
export type {
  CircularArrayRequest,
  EntityOpPoint,
  MirrorEntitiesRequest,
  OffsetEntitiesRequest,
  RectangularArrayRequest,
  SketchEntityOpError,
  SketchEntityOpErrorCode,
} from "./entity-ops";

export {
  SKETCH_CONVERT_DECLINE_CODES,
  SKETCH_CONVERT_ERROR_CODES,
  convertTopologyEntities,
} from "./convert";
export type {
  ConvertedTopologyEntity,
  ConvertTopologyEntitiesRequest,
  SketchConvertDeclineCode,
  SketchConvertError,
  SketchConvertErrorCode,
} from "./convert";

export { analyzeConstrainedness } from "./constrainedness";
export type { SketchConstrainedness } from "./constrainedness";

export {
  DIAMETRAL_TEXT_STANDOFF_MM,
  DIMENSION_ANGULAR_ARC_RADIUS_MM,
  DIMENSION_ANGULAR_TEXT_STANDOFF_MM,
  DIMENSION_CIRCLE_ANCHOR_ANGLE_RAD,
  DIMENSION_EXTENSION_OVERSHOOT_MM,
  DIMENSION_LINE_OFFSET_MM,
  DIMENSION_TEXT_FRACTION,
  dimensionPresentation,
  dimensionText,
  pointTargetPosition,
  serializeDimensionPresentation,
  sketchDimensionPresentations,
} from "./dimensions";
export type {
  DimensionPoint,
  DimensionPresentation,
  SerializedDimensionPresentation,
} from "./dimensions";

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
  SKETCH_PROFILE_DEFLECTIONS,
  ellipsePoint,
  entityPolyline,
  profileLoopSignedArea,
  profileSegmentPolyline,
  resolveExtrudeProfile,
  resolveProfileLoops,
  resolveSweepPath,
} from "./profile";
export type {
  ProfileError,
  ProfileLoop,
  ProfilePoint,
  ProfileSegment,
  ResolvedProfile,
  ResolvedSweepPath,
  SweepPathSegment,
} from "./profile";
export {
  SPLINE_TESSELLATION_DEFLECTION_MM,
  SPLINE_TESSELLATION_MAX_DEPTH,
  bezierChainOfSpline,
  cubicStationaryParameters,
  evaluateSplinePoint,
  projectOntoSpline,
  splinePointGradient,
  splineTangent,
  splineTangentGradient,
  tessellateSpline,
} from "./spline-math";
export type {
  BezierSegment,
  SplineChain,
  SplineProjection,
  SplineTessellationVertex,
} from "./spline-math";
export { workplaneToPlacement } from "./workplane-placement";
export type {
  PlacementAxis,
  WorkplanePlacement,
  WorkplanePlacementRotation,
} from "./workplane-placement";

export type { SketchDimensionRecoveryOptions } from "./drawing-dimension-source";
export {
  dimensionalConstraintIdsOf,
  recoverSketchDimensions,
} from "./drawing-dimension-source";
