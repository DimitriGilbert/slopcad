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
  DatumId,
  FeatureId,
  ParameterId,
  ReferenceId,
  SketchDocumentId,
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
  "union",
  "subtract",
  "intersect",
  "use",
  "fillet",
  "chamfer",
  "shell",
  "thicken",
  "split",
  "hole",
  "rib",
  "thread",
  "helix",
  "scale",
  "moveFace",
  "replaceFace",
  "deleteFace",
  "patternLinear",
  "patternCircular",
  "patternPath",
  "mirror",
  "sketch",
  "point",
  "line",
  "rectangle",
  "circle",
  "arc",
  "ellipse",
  "slot",
  "polygon",
  "spline",
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

// ---------------------------------------------------------------------------
// Phase 2: the full element vocabulary
// ---------------------------------------------------------------------------

/**
 * A world-axis selector, serialized as the bridge's dimensionless parameter
 * (1 = X, 2 = Y, 3 = Z — the hole axis / mirror plane / pattern axis
 * selector discipline the kernel bridge reads).
 */
export type WorldAxis = "x" | "y" | "z";

/** A screw handedness (serialized as the bridge's +1 / −1 selector). */
export type Handedness = "right" | "left";

/** A thread mode (the bridge's dimensionless 1 = external, 2 = internal, 3 = cosmetic). */
export type ThreadMode = "external" | "internal" | "cosmetic";

/** A structured hole type (the bridge's dimensionless selectors 1–5). */
export type HoleType =
  "straight" | "counterbore" | "countersink" | "taper" | "threaded";

/** A path-pattern orientation (the bridge's 1 = fixed, 2 = tangent-follow). */
export type PatternOrientation = "fixed" | "tangent";

/** How a regular polygon's radius relates to its circle (cad-sketch's fits). */
export type PolygonFit = "inscribed" | "circumscribed";

/** A spline's flavor (cad-sketch's control-point / fit-point forms). */
export type SplineFlavor = "control" | "interpolated";

/** A slot's variant (cad-sketch's straight / 3-point-arc forms). */
export type SlotVariant = "straight" | "arc3";

/**
 * A persistent-reference record id (`ref_…`). Edge- and face-addressed
 * elements (`<Fillet>`, `<Chamfer>`, `<Shell>`, `<MoveFace>`,
 * `<ReplaceFace>`, `<DeleteFace>`) consume REFERENCE RECORDS the picking
 * layer mints against a live topology snapshot — a static JSX tree cannot
 * mint them, so the prop addresses a record the target document already
 * carries (the emitted feature input is exactly the `{ kind: "reference" }`
 * ref the bridge resolves).
 */
export type ReferenceProp = ReferenceId | (string & {});

/**
 * A datum record id (`dtm_…`) a datum-consuming element addresses. Datum
 * records are document entities this vocabulary cannot declare yet, so the
 * prop addresses a record the target document already carries.
 */
export type DatumProp = DatumId | (string & {});

/**
 * A sketch record id (`skd_…`) a sketch-consuming element addresses —
 * an in-scope `<Sketch id=…>` sibling declared earlier in the tree.
 */
export type SketchRefProp = SketchDocumentId | (string & {});

/** A feature id (`feat_…`) a `<Use>` consumes by reference. */
export type FeatureRefProp = FeatureId | (string & {});

/** A 3D point/vector with finite millimetre components. */
export interface Vec3Prop {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A workplane-space point of a spline (mm), as cad-sketch stores it. */
export interface SplinePointProp {
  readonly x: number;
  readonly y: number;
}

/** Props of `<Union>`: fuses its children's solids in declaration order. */
export interface UnionProps {
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** At least two producing children (nested solids or `<Use>` references). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Subtract>`: removes every child after the first from the
 * first child's solid (the base — the bridge's exact input order).
 */
export interface SubtractProps {
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /**
   * At least two producing children: the first is the BASE, the rest are
   * the TOOLS (the bridge's `kernel.subtract(target, tools)` order).
   */
  readonly children?: ReactNode;
}

/** Props of `<Intersect>`: keeps the common volume of its children's solids. */
export interface IntersectProps {
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** At least two producing children (nested solids or `<Use>` references). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Use>`: consumes an already-produced feature by reference —
 * the shared-subtree mechanism. The referenced element (which carries an
 * explicit `id` prop) stays wherever it stands in the tree; `<Use>`
 * resolves to the same feature input a nested form would produce, without
 * re-emitting it. The feature must be produced EARLIER in the tree.
 */
export interface UseProps {
  /** The produced feature to consume (`feat_…`). */
  readonly feature: FeatureRefProp;
}

/**
 * Props of `<Fillet>`: rounds the target's addressed edges. Edge
 * addressing is the bridge's persistent-reference discipline — see
 * {@link ReferenceProp}.
 */
export interface FilletProps {
  /** The fillet radius. */
  readonly radius: DimensionalProp;
  /** The edge reference record ids (`ref_…`) to round, in order. */
  readonly edges: readonly ReferenceProp[];
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/** Props of `<Chamfer>`: bevels the target's addressed edges by one distance. */
export interface ChamferProps {
  /** The symmetric chamfer distance. */
  readonly distance: DimensionalProp;
  /** The edge reference record ids (`ref_…`) to bevel, in order. */
  readonly edges: readonly ReferenceProp[];
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Shell>`: hollows the target, opening the addressed faces at a
 * uniform wall thickness. Face addressing is the bridge's persistent-
 * reference discipline — see {@link ReferenceProp}.
 */
export interface ShellProps {
  /** The uniform wall thickness. */
  readonly thickness: DimensionalProp;
  /** The face reference record ids (`ref_…`) to open, in order. */
  readonly faces: readonly ReferenceProp[];
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/** Props of `<Thicken>`: offsets the target's faces into a closed hollow. */
export interface ThickenProps {
  /** The wall thickness. */
  readonly thickness: DimensionalProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Split>`: keeps one side of the target relative to a datum
 * plane (the bridge's datum-PLANE input — see {@link DatumProp}).
 */
export interface SplitProps {
  /** The datum plane record id (`dtm_…`) that cuts the target. */
  readonly plane: DatumProp;
  /** Which half to keep: `1` the side the plane's normal points to, `-1` the other. */
  readonly keep: 1 | -1;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Hole>`: cuts a hole (or hole series) from its single target
 * child. Two bridge-faithful forms, dispatched by the presence of `type`:
 *
 * - the FLAT form (no `type`): `diameter`, `depth`, `positionX`,
 *   `positionY` (lengths) and the `axis` world selector — the bridge's
 *   five-parameter layout;
 * - the STRUCTURED form (`type` given): the type-directed role list the
 *   workbench's hole dialog authors (`structuredHoleRoles` order), with
 *   `positions` (an in-scope `<Sketch>` whose point entities place the
 *   holes) and `axisDatum` (a datum axis record) as the sketch/datum
 *   alternatives to `positionX`/`positionY` and `axis`.
 */
export interface HoleProps {
  /** Selects the structured form when present. */
  readonly type?: HoleType;
  /** The hole's nominal diameter (flat form, or any structured type but `threaded`). */
  readonly diameter?: DimensionalProp;
  /** The FULL axial extent to the drill tip point. */
  readonly depth?: DimensionalProp;
  /** The drill tip's INCLUDED angle (a plain number is canonical radians). */
  readonly tipAngle?: DimensionalProp;
  /** The counterbore diameter (`counterbore`). */
  readonly cboreDiameter?: DimensionalProp;
  /** The counterbore depth from the entry face (`counterbore`). */
  readonly cboreDepth?: DimensionalProp;
  /** The countersink rim diameter (`countersink`). */
  readonly csinkDiameter?: DimensionalProp;
  /** The countersink's INCLUDED angle (`countersink`). */
  readonly csinkAngle?: DimensionalProp;
  /** The taper's INCLUDED angle (`taper`). */
  readonly taperAngle?: DimensionalProp;
  /** The ISO major diameter (`threaded`). */
  readonly threadMajor?: DimensionalProp;
  /** The ISO pitch (`threaded`). */
  readonly threadPitch?: DimensionalProp;
  /** In-plane position along the basis's first axis (flat form, or structured without `positions`). */
  readonly positionX?: DimensionalProp;
  /** In-plane position along the basis's second axis (flat form, or structured without `positions`). */
  readonly positionY?: DimensionalProp;
  /** An in-scope `<Sketch id=…>` whose point entities are the hole positions. */
  readonly positions?: SketchRefProp;
  /** The world axis the hole runs along; defaults to `"z"`. */
  readonly axis?: WorldAxis;
  /** A datum axis record the hole runs parallel to (replaces `axis`). */
  readonly axisDatum?: DatumProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Rib>`: unions a symmetric double extrusion of the sketch's
 * profile with the target (the bridge's sketch + thickness layout).
 */
export interface RibProps {
  /** The rib's thickness (extruded half of it each way from the profile). */
  readonly thickness: DimensionalProp;
  /** An in-scope `<Sketch id=…>` carrying the rib's cross-section profile. */
  readonly sketch: SketchRefProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Thread>`: cuts an ISO thread on or in its single target along
 * the chosen axis (the bridge's five-parameter + axis layout).
 */
export interface ThreadProps {
  /** The ISO major diameter. */
  readonly majorDiameter: DimensionalProp;
  /** The ISO pitch. */
  readonly pitch: DimensionalProp;
  /** The thread's axial extent (its length along the axis). */
  readonly length: DimensionalProp;
  /** `external` grooves a rod, `internal` taps a hole, `cosmetic` changes no geometry; defaults to `external`. */
  readonly mode?: ThreadMode;
  /** Right- (default) or left-handed. */
  readonly handedness?: Handedness;
  /** The world axis the thread runs along; defaults to `"z"`. */
  readonly axis?: WorldAxis;
  /** A datum axis record the thread runs parallel to (replaces `axis`). */
  readonly axisDatum?: DatumProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Helix>`: sweeps a meridian profile along an analytic helical
 * spine — a PRODUCER (no target child), like a primitive. The sketch's
 * `(x, y)` becomes the meridian `(radial, axial)` offset; the sketch's own
 * workplane placement does not carry.
 */
export interface HelixProps {
  /** An in-scope `<Sketch id=…>` carrying the meridian profile. */
  readonly sketch: SketchRefProp;
  /** The spine radius (strictly positive — the kernel judges the domain). */
  readonly radius: DimensionalProp;
  /** The axial advance per turn. */
  readonly pitch: DimensionalProp;
  /** The number of turns (fractional legal). */
  readonly turns: DimensionalProp;
  /** Right- (default) or left-handed. */
  readonly handedness?: Handedness;
  /** The start angle on the spine; a plain number is canonical radians (default 0). */
  readonly startAngle?: DimensionalProp;
  /** The total signed radius change across the sweep (default 0 mm). */
  readonly taper?: DimensionalProp;
  /** A datum axis record the spine runs along (default: world +z through the origin). */
  readonly axis?: DatumProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
}

/** Props of `<Scale>`: uniformly scales its target by one factor. */
export interface ScaleProps {
  /** The uniform factor (the contract carries uniform scaling only). */
  readonly factor: DimensionalProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<MoveFace>`: translates one addressed face of the target along
 * a world axis. Face addressing is the bridge's persistent-reference
 * discipline — see {@link ReferenceProp}.
 */
export interface MoveFaceProps {
  /** The face reference record id (`ref_…`) to move. */
  readonly face: ReferenceProp;
  /** The world axis to move the face along. */
  readonly axis: WorldAxis;
  /** How far to move the face (signed). */
  readonly distance: DimensionalProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<ReplaceFace>`: re-closes one addressed face of the target
 * onto a datum plane.
 */
export interface ReplaceFaceProps {
  /** The face reference record id (`ref_…`) to replace. */
  readonly face: ReferenceProp;
  /** The datum plane record id (`dtm_…`) to close the face onto. */
  readonly plane: DatumProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<DeleteFace>`: removes one addressed face from the target,
 * optionally healing the gap (the kernel's own structured refusal is the
 * honest answer where its engine cannot heal).
 */
export interface DeleteFaceProps {
  /** The face reference record id (`ref_…`) to delete. */
  readonly face: ReferenceProp;
  /** Extend the neighbours to close the gap (default) or leave it open. */
  readonly heal?: boolean;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the target solid). */
  readonly children?: ReactNode;
}

/**
 * Props of `<PatternLinear>`: repeats its target along a direction in the
 * world XY plane, `count` copies `spacing` apart.
 */
export interface PatternLinearProps {
  /** The copy count (a dimensionless value; the bridge demands an integer ≥ 2). */
  readonly count: DimensionalProp;
  /** The spacing between copy origins (strictly positive — the kernel judges). */
  readonly spacing: DimensionalProp;
  /**
   * The direction, counter-clockwise from world +x in the XY plane; a
   * plain number is canonical radians (default 0 = +x).
   */
  readonly direction?: DimensionalProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the solid to repeat). */
  readonly children?: ReactNode;
}

/**
 * Props of `<PatternCircular>`: repeats its target about a world axis
 * line through the origin, `count` copies over `totalAngle`.
 */
export interface PatternCircularProps {
  /** The copy count (a dimensionless value; the bridge demands an integer ≥ 2). */
  readonly count: DimensionalProp;
  /** The total angle the copies span; a plain number is canonical radians (2π = one full turn). */
  readonly totalAngle: DimensionalProp;
  /** The world axis the copies rotate about; defaults to `"z"`. */
  readonly axis?: WorldAxis;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the solid to repeat). */
  readonly children?: ReactNode;
}

/**
 * Props of `<PatternPath>`: repeats its target at `spacing` arc-length
 * steps along a sketch path.
 */
export interface PatternPathProps {
  /** The instance count (a dimensionless value; the bridge demands an integer ≥ 2). */
  readonly count: DimensionalProp;
  /** The arc-length step between instances. */
  readonly spacing: DimensionalProp;
  /** `fixed` translates only (default); `tangent` also rotates each copy onto the path tangent. */
  readonly orientation?: PatternOrientation;
  /** An in-scope `<Sketch id=…>` carrying the path chain. */
  readonly sketch: SketchRefProp;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the solid to repeat). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Mirror>`: reflects its target across a plane. The `plane` prop
 * selects the bridge's exact form: a world axis (`"x"`, `"y"`, `"z"` — the
 * plane normal's axis) uses the two-parameter selector layout with
 * `offset`, while a datum record id (`dtm_…`) uses the datum-plane
 * layout with the optional `merge`.
 */
export interface MirrorProps {
  /** The mirror plane: a world axis name, or a datum plane record id. */
  readonly plane: WorldAxis | DatumProp;
  /** The plane's signed position along its normal (world-axis form); defaults to 0 mm. */
  readonly offset?: DimensionalProp;
  /** Union the reflection with its original instead of standing alone (datum form). */
  readonly merge?: boolean;
  /** Explicit feature id (`feat_…`); body and parameter ids derive from it. */
  readonly id?: FeatureId | (string & {});
  /** Exactly one producing child (the solid to reflect). */
  readonly children?: ReactNode;
}

/**
 * Props of `<Sketch>`: a document sketch record carrying the cad-sketch
 * canonical serialized form, built from its entity children. The
 * workplane frame (origin, normal, xAxis) must be orthonormal and
 * right-handed — it is stored verbatim, exactly as cad-sketch parses it.
 */
export interface SketchProps {
  /** Explicit sketch record id (`skd_…`); defaults to `skd_sketch-<n>`. */
  readonly id?: SketchRefProp;
  /** The sketch's display name; defaults to a name derived from the id. */
  readonly name?: string;
  /** The workplane origin (mm); defaults to the world origin. */
  readonly origin?: Vec3Prop;
  /** The workplane normal (unit, perpendicular to `xAxis`); defaults to +z. */
  readonly normal?: Vec3Prop;
  /** The workplane x axis (unit, perpendicular to `normal`); defaults to +x. */
  readonly xAxis?: Vec3Prop;
  /** Entity children only (`<Line>`, `<Circle>`, …). */
  readonly children?: ReactNode;
}

/** Props of `<Point>`: a sketch point at `(x, y)` (workplane mm). */
export interface PointProps {
  readonly x: number;
  readonly y: number;
  /** Explicit entity id (`skent_…`); defaults to `skent_point-<n>`. */
  readonly id?: string;
}

/** Props of `<Line>`: a sketch line from `(x1, y1)` to `(x2, y2)`. */
export interface LineProps {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Explicit entity id (`skent_…`); defaults to `skent_line-<n>`. */
  readonly id?: string;
}

/**
 * Props of `<Rectangle>`: an axis-aligned rectangle from corner
 * `(x1, y1)` to the opposite corner `(x2, y2)` — compiled to cad-sketch's
 * four chained line entities (bottom, right, top, left) plus the
 * rectangle entity that references them in edge order.
 */
export interface RectangleProps {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Explicit entity id (`skent_…`); defaults to `skent_rectangle-<n>`. */
  readonly id?: string;
}

/** Props of `<Circle>`: a sketch circle (center + positive radius). */
export interface CircleProps {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  /** Explicit entity id (`skent_…`); defaults to `skent_circle-<n>`. */
  readonly id?: string;
}

/**
 * Props of `<Arc>`: a sketch arc — center, positive radius, and the CCW
 * sweep from `startAngle` to `endAngle` (radians, canonicalized to
 * [0, 2π); a zero or full-turn sweep is degenerate).
 */
export interface ArcProps {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly startAngle: number;
  readonly endAngle: number;
  /** Explicit entity id (`skent_…`); defaults to `skent_arc-<n>`. */
  readonly id?: string;
}

/**
 * Props of `<Ellipse>`: a sketch ellipse — center, positive semi-axes, and
 * the rotation of the radiusX axis from workplane +x (radians,
 * canonicalized to [0, 2π)).
 */
export interface EllipseProps {
  readonly cx: number;
  readonly cy: number;
  readonly radiusX: number;
  readonly radiusY: number;
  readonly rotation?: number;
  /** Explicit entity id (`skent_…`); defaults to `skent_ellipse-<n>`. */
  readonly id?: string;
}

/**
 * Props of `<Slot>`: a sketch slot (stadium/obround). `straight`: two
 * distinct cap centers + cap radius. `arc3`: the centerline arc through
 * `(x1,y1)`, `(x2,y2)`, `(x3,y3)` + cap radius (three distinct,
 * non-collinear points whose circumradius exceeds the cap radius).
 */
export interface SlotProps {
  readonly variant: SlotVariant;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** The centerline arc's END point (`arc3` only). */
  readonly x3?: number;
  /** The centerline arc's END point (`arc3` only). */
  readonly y3?: number;
  readonly radius: number;
  /** Explicit entity id (`skent_…`); defaults to `skent_slot-<n>`. */
  readonly id?: string;
}

/**
 * Props of `<Polygon>`: a regular polygon — center, positive radius, side
 * count (3–128), first-vertex rotation (radians), and whether `radius` is
 * the circumradius (`inscribed`) or inradius (`circumscribed`).
 */
export interface PolygonProps {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly sides: number;
  readonly rotation?: number;
  readonly fit: PolygonFit;
  /** Explicit entity id (`skent_…`); defaults to `skent_polygon-<n>`. */
  readonly id?: string;
}

/**
 * Props of `<Spline>`: a sketch spline. `control` points must number 4,
 * 7, 10, … (a cubic Bézier chain); `interpolated` points (≥ 2, consecutive
 * distinct) are fit points the curve passes through.
 */
export interface SplineProps {
  readonly flavor: SplineFlavor;
  readonly points: readonly SplinePointProp[];
  /** Explicit entity id (`skent_…`); defaults to `skent_spline-<n>`. */
  readonly id?: string;
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

/** Fuses its children's solids: `feature.create` of kind `union`. */
export const Union = defineCadElement<UnionProps>("union");

/** Removes tools (children after the first) from a base: kind `subtract`. */
export const Subtract = defineCadElement<SubtractProps>("subtract");

/** Keeps the common volume of its children: kind `intersect`. */
export const Intersect = defineCadElement<IntersectProps>("intersect");

/** Consumes an already-produced feature by reference (emits no commands). */
export const Use = defineCadElement<UseProps>("use");

/** Rounds addressed edges of its target: kind `fillet`. */
export const Fillet = defineCadElement<FilletProps>("fillet");

/** Bevels addressed edges of its target: kind `chamfer`. */
export const Chamfer = defineCadElement<ChamferProps>("chamfer");

/** Hollows its target, opening addressed faces: kind `shell`. */
export const Shell = defineCadElement<ShellProps>("shell");

/** Offsets its target's faces into a closed hollow: kind `thicken`. */
export const Thicken = defineCadElement<ThickenProps>("thicken");

/** Keeps one side of its target relative to a datum plane: kind `split`. */
export const Split = defineCadElement<SplitProps>("split");

/** Cuts a hole (flat or structured form) from its target: kind `hole`. */
export const Hole = defineCadElement<HoleProps>("hole");

/** Unions a symmetric double extrusion of a sketch with its target: kind `rib`. */
export const Rib = defineCadElement<RibProps>("rib");

/** Cuts an ISO thread on or in its target: kind `thread`. */
export const Thread = defineCadElement<ThreadProps>("thread");

/** Sweeps a meridian profile along a helical spine (a producer): kind `helix`. */
export const Helix = defineCadElement<HelixProps>("helix");

/** Uniformly scales its target by one factor: kind `scale`. */
export const Scale = defineCadElement<ScaleProps>("scale");

/** Translates one addressed face of its target: kind `moveFace`. */
export const MoveFace = defineCadElement<MoveFaceProps>("moveFace");

/** Re-closes one addressed face onto a datum plane: kind `replaceFace`. */
export const ReplaceFace = defineCadElement<ReplaceFaceProps>("replaceFace");

/** Removes one addressed face from its target: kind `deleteFace`. */
export const DeleteFace = defineCadElement<DeleteFaceProps>("deleteFace");

/** Repeats its target along a world-XY direction: kind `patternLinear`. */
export const PatternLinear =
  defineCadElement<PatternLinearProps>("patternLinear");

/** Repeats its target about a world axis: kind `patternCircular`. */
export const PatternCircular =
  defineCadElement<PatternCircularProps>("patternCircular");

/** Repeats its target along a sketch path: kind `patternPath`. */
export const PatternPath = defineCadElement<PatternPathProps>("patternPath");

/** Reflects its target across a plane: kind `mirror`. */
export const Mirror = defineCadElement<MirrorProps>("mirror");

/** A document sketch record (cad-sketch canonical form): `sketch.create`. */
export const Sketch = defineCadElement<SketchProps>("sketch");

/** A sketch point entity. */
export const Point = defineCadElement<PointProps>("point");

/** A sketch line entity. */
export const Line = defineCadElement<LineProps>("line");

/** A sketch rectangle: four chained lines plus the rectangle entity. */
export const Rectangle = defineCadElement<RectangleProps>("rectangle");

/** A sketch circle entity. */
export const Circle = defineCadElement<CircleProps>("circle");

/** A sketch arc entity. */
export const Arc = defineCadElement<ArcProps>("arc");

/** A sketch ellipse entity. */
export const Ellipse = defineCadElement<EllipseProps>("ellipse");

/** A sketch slot entity (straight or 3-point-arc). */
export const Slot = defineCadElement<SlotProps>("slot");

/** A sketch regular polygon entity. */
export const Polygon = defineCadElement<PolygonProps>("polygon");

/** A sketch spline entity (control or interpolated). */
export const Spline = defineCadElement<SplineProps>("spline");
