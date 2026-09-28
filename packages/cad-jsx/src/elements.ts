/**
 * The CAD element vocabulary: the JSX tags a model is authored with.
 *
 * ## No second parametric representation (the hard rule)
 *
 * An element tag is **pure authoring data**. It carries no geometry, no
 * graph, no evaluator — only a `kind` string the compiler
 * (`./compiler.ts`) recognizes and lowers onto the Phase 7 command
 * vocabulary (`@slopcad/cad-core`'s `parameter.create` / `parameter.set` /
 * `body.create` / `feature.create`). The tag exists as a callable branded
 * function because React element types must be functions (or strings) for
 * a tag to be usable in JSX — `<Box width={10} />` type-checks as a normal
 * function component while the runtime brand (`cadElementBrand`)
 * distinguishes it from user components during the compile walk. Invoking
 * a tag directly throws: these are never rendered, only compiled.
 */

import type {
  AnyDimensionalValue,
  BodyId,
  FeatureId,
  ParameterId,
} from "@slopcad/cad-core";
import type { FunctionComponent, ReactNode } from "react";

/**
 * The runtime brand separating CAD element tags from user function
 * components. Exported (and documented) because the {@link CadElementTag}
 * interface keys on it; treat it as opaque.
 */
export const CAD_ELEMENT_BRAND: unique symbol = Symbol(
  "@slopcad/cad-jsx/element",
);

/**
 * A CAD element tag: a frozen, branded function whose only job is to ride
 * as a React element's `type` and carry the element `kind` the compiler
 * dispatches on. Callable only so JSX/`createElement` accept it as a tag;
 * the call always throws (see {@link defineCadElement}).
 */
export interface CadElementTag<P> extends FunctionComponent<P> {
  /** The element kind the compiler dispatches on (e.g. `"box"`). */
  readonly kind: string;
  /** The brand separating CAD elements from user function components. */
  readonly [CAD_ELEMENT_BRAND]: true;
}

/** The element kinds this package ships (the compiler's supported set). */
export const CAD_ELEMENT_KINDS = [
  "parameter",
  "body",
  "box",
  "sphere",
  "cylinder",
  "cone",
  "translate",
] as const;

/** A shipped element kind. */
export type CadElementKind = (typeof CAD_ELEMENT_KINDS)[number];

/**
 * Defines a CAD element tag for `kind`. The returned tag is frozen and
 * branded; use it as the JSX tag (`<Box width={10} />`) or the element
 * type (`createElement(Box, { width: 10 })`). Throws at definition time
 * when `kind` is not a non-empty string (a module-init programmer error,
 * not a compile failure).
 */
export function defineCadElement<P>(kind: string): CadElementTag<P> {
  if (typeof kind !== "string" || kind.length === 0) {
    throw new RangeError(
      "A CAD element kind must be a non-empty string (the compiler dispatches on it).",
    );
  }
  const tag: CadElementTag<P> = Object.assign(
    (): ReactNode => {
      throw new Error(
        `The CAD element "${kind}" is model data for compileModel from "@slopcad/cad-jsx", not a renderable component; it must never be invoked.`,
      );
    },
    { kind, [CAD_ELEMENT_BRAND]: true as const },
  );
  return Object.freeze(tag);
}

/**
 * A length-valued prop value: a plain number (canonical millimetres), an
 * explicit dimensional quantity (`length(2, "cm")` from `@slopcad/cad-core`),
 * or the id of a `<Parameter>` declared earlier in the tree
 * (`"param_width"` — the feature consumes the parameter instead of
 * creating its own). A bare string is always read as a parameter id.
 */
export type DimensionalProp =
  number | AnyDimensionalValue | ParameterId | (string & {});

/** Props of `<Parameter>`: a named, dimensionally typed document parameter. */
export interface ParameterProps {
  /** The parameter name (an expression identifier, e.g. `width`). */
  readonly name: string;
  /** The value: a plain number is canonicalized as millimetres. */
  readonly value: number | AnyDimensionalValue;
  /** Explicit parameter id (`param_…`); defaults to `param_<name>`. */
  readonly id?: ParameterId | (string & {});
}

/**
 * Props of `<Body>`: a document body record. When `<Body>` wraps exactly
 * one producing child (`<Box>`, `<Sphere>`, `<Cylinder>`, `<Cone>`, or
 * `<Translate>`), that child's feature outputs THIS body; the child then
 * creates no body of its own.
 */
export interface BodyProps {
  /** The body's display name (non-empty string). */
  readonly name: string;
  /** Explicit body id (`body_…`); defaults to a slug of the name. */
  readonly id?: BodyId | (string & {});
  readonly children?: ReactNode;
}

/** Props of `<Box>`: a width × depth × height box, per the kernel bridge. */
export interface BoxProps {
  readonly width: DimensionalProp;
  readonly depth: DimensionalProp;
  readonly height: DimensionalProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
}

/** Props of `<Sphere>`: a radius-sized sphere, per the kernel bridge. */
export interface SphereProps {
  readonly radius: DimensionalProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
}

/** Props of `<Cylinder>`: a radius × height cylinder, per the kernel bridge. */
export interface CylinderProps {
  readonly radius: DimensionalProp;
  readonly height: DimensionalProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
}

/** Props of `<Cone>`: bottom/top radius and height, per the kernel bridge. */
export interface ConeProps {
  readonly bottomRadius: DimensionalProp;
  readonly topRadius: DimensionalProp;
  readonly height: DimensionalProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
}

/**
 * Props of `<Translate>`: offsets the solid produced by its single child
 * element. Exactly one producing child is required (fragments, arrays,
 * and `null`/`false` children flatten transparently) — enforced at
 * compile time with a structured error, since `createElement`'s
 * children-argument form cannot carry it in the props type.
 */
export interface TranslateProps {
  /** Offset along world X; defaults to 0 mm. */
  readonly x?: DimensionalProp;
  /** Offset along world Y; defaults to 0 mm. */
  readonly y?: DimensionalProp;
  /** Offset along world Z; defaults to 0 mm. */
  readonly z?: DimensionalProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  readonly children?: ReactNode;
}

/**
 * Type guard recognizing a {@link CadElementTag} in an arbitrary element
 * `type`: a function carrying the package brand and a string `kind`. This
 * is what separates CAD elements from user function components during the
 * compiler's walk.
 */
export function isCadElementTag<P>(tag: unknown): tag is CadElementTag<P> {
  if (typeof tag !== "function") return false;
  if (Reflect.get(tag, CAD_ELEMENT_BRAND) !== true) return false;
  return typeof Reflect.get(tag, "kind") === "string";
}

/** Declares a document parameter (`parameter.create`; re-declaration is `parameter.set`). */
export const Parameter = defineCadElement<ParameterProps>("parameter");

/** Creates a body record (`body.create`) and captures one producing child's output. */
export const Body = defineCadElement<BodyProps>("body");

/** A box primitive: `feature.create` of kind `box`. */
export const Box = defineCadElement<BoxProps>("box");

/** A sphere primitive: `feature.create` of kind `sphere`. */
export const Sphere = defineCadElement<SphereProps>("sphere");

/** A cylinder primitive: `feature.create` of kind `cylinder`. */
export const Cylinder = defineCadElement<CylinderProps>("cylinder");

/** A cone primitive: `feature.create` of kind `cone`. */
export const Cone = defineCadElement<ConeProps>("cone");

/** A rigid translation of its child solid: `feature.create` of kind `translate`. */
export const Translate = defineCadElement<TranslateProps>("translate");
