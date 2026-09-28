/**
 * `@slopcad/cad-jsx`: author CAD models as React element trees, compiled
 * deterministically to the `@slopcad/cad-core` command vocabulary.
 *
 * The public surface is the element vocabulary (`./elements.ts`) and the
 * compiler entry point (`compileModel` from `./compiler.ts`). See the
 * package README for the authoring guide, the id assignment scheme, and
 * the determinism guarantees.
 */

export type {
  BodyProps,
  BoxProps,
  CadElementKind,
  CadElementTag,
  ConeProps,
  CylinderProps,
  DimensionalProp,
  ParameterProps,
  SphereProps,
  TranslateProps,
} from "./elements";
export {
  Body,
  Box,
  CAD_ELEMENT_KINDS,
  Cone,
  Cylinder,
  defineCadElement,
  isCadElementTag,
  Parameter,
  Sphere,
  Translate,
} from "./elements";

export type { CadJsxCompileError, CadJsxErrorCode } from "./compiler";
export { CAD_JSX_ERROR_CODES, compileModel } from "./compiler";
