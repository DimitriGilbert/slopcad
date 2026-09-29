/**
 * `@slopcad/cad-jsx`: author CAD models as React element trees, compiled
 * deterministically to the `@slopcad/cad-core` command vocabulary.
 *
 * The public surface is the element vocabulary (`./elements.ts`), the
 * compiler entry point (`compileModel` from `./compiler.ts`), the
 * native emission bridge (`compileToNative` from `./native.ts` — compile,
 * fold over a fresh document, serialize to the native `slopcad` format's
 * canonical text), and the generator (`generateTsx` from `./generate.ts`
 * — the compiler's inverse over a document's records). The canonical
 * TSX loader (`./loader.ts`, imported as `@slopcad/cad-jsx/loader`) is
 * Node-only and deliberately NOT re-exported here, so browser bundles
 * never pull esbuild or `node:vm`. See the package README for the
 * authoring guide, the id assignment scheme, the reference mechanisms
 * (`<Use>` for shared features, `ref_…`/`dtm_…` props for records minted
 * outside the tree, `<Sketch id=…>` siblings for sketch-consuming
 * elements), the native emission and CLI, and the determinism guarantees.
 */

export type {
  ArcProps,
  BodyProps,
  BoxProps,
  CadElementKind,
  CadElementTag,
  ChamferProps,
  CircleProps,
  ConeProps,
  CurveProp,
  CylinderProps,
  DeleteFaceProps,
  DimensionalProp,
  DatumProp,
  EllipseProps,
  ExtrudeProps,
  FeatureRefProp,
  FilletProps,
  HelixProps,
  HoleProps,
  HoleType,
  Handedness,
  IntersectProps,
  LineProps,
  LoftProps,
  LoftSectionProp,
  MirrorProps,
  MoveFaceProps,
  ParameterProps,
  PatternCircularProps,
  PatternLinearProps,
  PatternOrientation,
  PatternPathProps,
  PointProps,
  PolygonFit,
  PolygonProps,
  RectangleProps,
  ReferenceProp,
  ReplaceFaceProps,
  RevolveProps,
  RibProps,
  ScaleProps,
  ShellProps,
  SketchProps,
  SketchRefProp,
  SlotProps,
  SlotVariant,
  SphereProps,
  SplineFlavor,
  SplinePointProp,
  SplineProps,
  SplitProps,
  SubtractProps,
  SweepProps,
  SweepWireProps,
  ThreadMode,
  ThreadProps,
  TranslateProps,
  UnionProps,
  UseProps,
  Vec3Prop,
  WorldAxis,
} from "./elements";
export {
  Arc,
  Body,
  Box,
  CAD_ELEMENT_KINDS,
  Chamfer,
  Circle,
  Cone,
  Cylinder,
  defineCadElement,
  DeleteFace,
  Ellipse,
  Extrude,
  Fillet,
  Helix,
  Hole,
  Intersect,
  isCadElementTag,
  Line,
  Loft,
  Mirror,
  MoveFace,
  Parameter,
  PatternCircular,
  PatternLinear,
  PatternPath,
  Point,
  Polygon,
  Rectangle,
  ReplaceFace,
  Revolve,
  Rib,
  Scale,
  Shell,
  Sketch,
  Slot,
  Sphere,
  Split,
  Spline,
  Subtract,
  Sweep,
  SweepWire,
  Thread,
  Translate,
  Union,
  Use,
} from "./elements";

export type { CadJsxCompileError, CadJsxErrorCode } from "./compiler";
export { CAD_JSX_ERROR_CODES, compileModel } from "./compiler";
export type {
  CompileToNativeOptions,
  NativeEmitError,
  NativeEmitErrorCode,
} from "./native";
export {
  compileToNative,
  DEFAULT_NATIVE_DOCUMENT_ID,
  NATIVE_EMIT_ERROR_CODES,
  NATIVE_EMIT_METADATA,
} from "./native";
export type {
  GenerateTsxErrorCode,
  GenerateTsxOptions,
  GeneratedTsx,
  TsxDeclineNote,
  TsxGenerateError,
} from "./generate";
export { GENERATE_TSX_ERROR_CODES, generateTsx } from "./generate";
// The authoring helpers for dimensional quantities, re-exported so a
// model's ONLY import is this package: `<Parameter value={angle(Math.PI)}`
// and explicit `<Parameter>` values of non-length dimensions need them
// (a plain number is canonical millimetres).
export { angle, dimensionless, length } from "@slopcad/cad-core";
