/**
 * The TSX generator (Phase 4): the compiler's inverse — a pure walk over a
 * `CadDocument`'s records that emits TypeScript/TSX source which, compiled
 * by THIS package through the canonical loader discipline
 * (`./loader.ts`'s transpile → sandbox evaluate → `compileToNative`),
 * reproduces the document byte-stably.
 *
 * ## The canonical form (the round-trip contract)
 *
 * The compiler walks a tree and emits `parameter.create` / `body.create` /
 * `sketch.create` / `feature.create` commands in walk order; the document
 * preserves each kind's relative order (parameters by insertion, bodies,
 * features, and sketches by add order) but not the interleaving. The
 * generator therefore emits ONE canonical tree and VALIDATES that its
 * emission order matches the document's four sequences exactly
 * (`parameter-order` / `body-order` / `sketch-order` / `feature-order`
 * failures otherwise — a refusal, never a silent diff):
 *
 * - explicit parameters (every parameter not an implicit per-feature
 *   parameter) first, in document parameter order, as `<Parameter>` —
 *   angle and dimensionless values through the `angle()`/`dimensionless()`
 *   authoring helpers re-exported by this package;
 * - each sketch immediately before the FIRST consuming feature's
 *   top-level element, as a `<Sketch id=…>` sibling carrying its entity
 *   children (ids verbatim); sketches no surviving feature consumes close
 *   the model, in sketch order;
 * - the feature DAG in timeline order: a feature consumed by exactly one
 *   later feature nests as that consumer's child; a feature consumed by
 *   two or more later features stands alone and its consumers reference
 *   it through `<Use feature="…">`;
 * - a feature whose output body's name is not the compiler's derived
 *   standalone name is wrapped in `<Body id=… name=…>` (the only way the
 *   compiler can have produced that name); bare body records (no
 *   producing feature) close the model, in body order.
 *
 * A document authored in this discipline — parameters first, sketches at
 * their first consumer, features in timeline order — round-trips
 * byte-identically up to the two fields the pipeline legitimately
 * regenerates (the document id and the metadata block, which belong to
 * the emitting options, not the model).
 *
 * ## Declines (never silent drops)
 *
 * Records the JSX vocabulary cannot declare — datum, curve, and
 * persistent-reference records; sections, occurrences, mates, joints, and
 * configurations; suppressed/display-flagged/appearance bodies;
 * expression- or metadata-carrying parameters; features whose input
 * layouts are not the compiler's (reference/datum/curve inputs, unknown
 * kinds, foreign shapes) — are DECLINED: each decline is a structured
 * note (kind, id, reason) returned as data and listed in the generated
 * file's header comment block. Declines cascade: a feature that consumes
 * a declined record declines with it.
 *
 * Determinism: no clock, randomness, or environment — the same document
 * (and options) generates the identical source. Pure: only
 * `@slopcad/cad-core` types and string building — browser-safe.
 */

import { CANONICAL_UNITS, valueIn } from "@slopcad/cad-core";
import type {
  AnyDimensionalValue,
  Body,
  CadDocument,
  Dimension,
  DocumentSketch,
  FeatureInputRef,
  FeatureRecord,
  Parameter,
  ParseFailure,
  ParseResult,
} from "@slopcad/cad-core";

/** Stable failure codes produced when a document cannot be generated. */
export const GENERATE_TSX_ERROR_CODES = {
  /** The parameters' creation order is not the canonical form's. */
  parameterOrder: "cadjsx-generate/parameter-order",
  /** The bodies' creation order is not the canonical form's. */
  bodyOrder: "cadjsx-generate/body-order",
  /** The sketches' creation order is not the canonical form's. */
  sketchOrder: "cadjsx-generate/sketch-order",
  /** The features' creation order is not the canonical form's. */
  featureOrder: "cadjsx-generate/feature-order",
} as const;

export type GenerateTsxErrorCode =
  (typeof GENERATE_TSX_ERROR_CODES)[keyof typeof GENERATE_TSX_ERROR_CODES];

/** Structured failure describing why generation was refused. */
export interface TsxGenerateError extends ParseFailure {
  readonly code: GenerateTsxErrorCode;
}

/** One declined record: present in the document, absent from the model. */
export interface TsxDeclineNote {
  /**
   * The record's family (datum, curve, reference, sketch, body,
   * parameter, feature, section, occurrence, mate, joint, configuration).
   */
  readonly kind: string;
  /** The declined record's id, verbatim. */
  readonly id: string;
  /** Why the record has no JSX form here. */
  readonly reason: string;
}

/** The generated model: the source plus the decline ledger. */
export interface GeneratedTsx {
  /** Complete, compilable TSX source (header comments included). */
  readonly source: string;
  /** Every declined record, in walk order — data, not just comments. */
  readonly declines: readonly TsxDeclineNote[];
  /** The element tags and helpers the source imports (host diagnostics). */
  readonly imports: readonly string[];
}

/** Options for {@link generateTsx}; every field optional. */
export interface GenerateTsxOptions {
  /** Names the source document in the header comment (provenance only). */
  readonly documentId?: string;
}

// ---------------------------------------------------------------------------
// The per-kind inverse table (the compiler's exact input layouts)
// ---------------------------------------------------------------------------

/** The dimensions a role may carry (the compiler's `PropDimension`). */
type RoleDimension = "length" | "angle" | "dimensionless";

/** A selector role: a dimensionless parameter mapped to an enum string. */
interface SelectorRole {
  readonly kind: "selector";
  readonly prop: string;
  /** Enum key → the bridge's selector constant. */
  readonly mapping: Readonly<Record<string, number>>;
}

/** A numeric role: a length/angle/dimensionless parameter (literal or ref). */
interface DimensionRole {
  readonly kind: "dimension";
  readonly prop: string;
  readonly dimension: RoleDimension;
  /**
   * Omit a literal equal to this: the compiler re-creates the identical
   * default parameter, so the bytes are equal with a cleaner element.
   */
  readonly omitWhen?: number;
}

/** One role of one feature kind's parameter tail. */
type RoleSpec = SelectorRole | DimensionRole;

/** The selector maps, mirrored from the compiler's tables. */
const WORLD_AXIS = { x: 1, y: 2, z: 3 } as const;
const HOLE_TYPE = {
  straight: 1,
  counterbore: 2,
  countersink: 3,
  taper: 4,
  threaded: 5,
} as const;
const THREAD_MODE = { external: 1, internal: 2, cosmetic: 3 } as const;
const HANDEDNESS = { right: 1, left: -1 } as const;
const PATTERN_ORIENTATION = { fixed: 1, tangent: 2 } as const;

/**
 * The structured hole's type-directed roles, mirroring the compiler's
 * `HOLE_TYPE_ROLES` order (the type's own dimensions, in declared order).
 */
const HOLE_TYPE_ROLES: Readonly<Record<string, readonly DimensionRole[]>> = {
  straight: [
    { kind: "dimension", prop: "diameter", dimension: "length" },
    { kind: "dimension", prop: "depth", dimension: "length" },
    { kind: "dimension", prop: "tipAngle", dimension: "angle" },
  ],
  counterbore: [
    { kind: "dimension", prop: "diameter", dimension: "length" },
    { kind: "dimension", prop: "depth", dimension: "length" },
    { kind: "dimension", prop: "tipAngle", dimension: "angle" },
    { kind: "dimension", prop: "cboreDiameter", dimension: "length" },
    { kind: "dimension", prop: "cboreDepth", dimension: "length" },
  ],
  countersink: [
    { kind: "dimension", prop: "diameter", dimension: "length" },
    { kind: "dimension", prop: "depth", dimension: "length" },
    { kind: "dimension", prop: "tipAngle", dimension: "angle" },
    { kind: "dimension", prop: "csinkDiameter", dimension: "length" },
    { kind: "dimension", prop: "csinkAngle", dimension: "angle" },
  ],
  taper: [
    { kind: "dimension", prop: "diameter", dimension: "length" },
    { kind: "dimension", prop: "depth", dimension: "length" },
    { kind: "dimension", prop: "taperAngle", dimension: "angle" },
  ],
  threaded: [
    { kind: "dimension", prop: "depth", dimension: "length" },
    { kind: "dimension", prop: "tipAngle", dimension: "angle" },
    { kind: "dimension", prop: "threadMajor", dimension: "length" },
    { kind: "dimension", prop: "threadPitch", dimension: "length" },
  ],
};

/** One pre-tail input slot. */
type PrefixSpec =
  | { readonly kind: "feature" }
  | { readonly kind: "features"; readonly min: number }
  | { readonly kind: "sketch"; readonly prop: string };

/**
 * Every representable feature kind's signature. `prefix` consumes the
 * inputs BEFORE the parameter tail (feature inputs and sketch inputs);
 * `roles` is the parameter tail in the compiler's declared order. Kinds
 * whose tail the table cannot express (extrude's signed height, revolve's
 * axis alternative, hole's two forms, loft's interleaved stations,
 * mirror's selector form, helix's tail) carry `custom` and match in
 * `planCustomKind` instead; kinds absent from the table are declined.
 */
interface KindLayout {
  readonly tag: string;
  readonly prefix: readonly PrefixSpec[];
  readonly roles: readonly RoleSpec[];
  readonly custom?: true;
}

/** Every kind the generator lowers; absent kinds are declined as unknown. */
const KIND_LAYOUTS: Readonly<Record<string, KindLayout>> = {
  box: {
    tag: "Box",
    prefix: [],
    roles: [
      { kind: "dimension", prop: "width", dimension: "length" },
      { kind: "dimension", prop: "depth", dimension: "length" },
      { kind: "dimension", prop: "height", dimension: "length" },
    ],
  },
  sphere: {
    tag: "Sphere",
    prefix: [],
    roles: [{ kind: "dimension", prop: "radius", dimension: "length" }],
  },
  cylinder: {
    tag: "Cylinder",
    prefix: [],
    roles: [
      { kind: "dimension", prop: "radius", dimension: "length" },
      { kind: "dimension", prop: "height", dimension: "length" },
    ],
  },
  cone: {
    tag: "Cone",
    prefix: [],
    roles: [
      { kind: "dimension", prop: "bottomRadius", dimension: "length" },
      { kind: "dimension", prop: "topRadius", dimension: "length" },
      { kind: "dimension", prop: "height", dimension: "length" },
    ],
  },
  translate: {
    tag: "Translate",
    prefix: [{ kind: "feature" }],
    roles: [
      { kind: "dimension", prop: "x", dimension: "length", omitWhen: 0 },
      { kind: "dimension", prop: "y", dimension: "length", omitWhen: 0 },
      { kind: "dimension", prop: "z", dimension: "length", omitWhen: 0 },
    ],
  },
  union: { tag: "Union", prefix: [{ kind: "features", min: 2 }], roles: [] },
  subtract: {
    tag: "Subtract",
    prefix: [{ kind: "features", min: 2 }],
    roles: [],
  },
  intersect: {
    tag: "Intersect",
    prefix: [{ kind: "features", min: 2 }],
    roles: [],
  },
  extrude: { tag: "Extrude", prefix: [], roles: [], custom: true },
  revolve: { tag: "Revolve", prefix: [], roles: [], custom: true },
  sweep: {
    tag: "Sweep",
    prefix: [
      { kind: "sketch", prop: "profile" },
      { kind: "sketch", prop: "path" },
    ],
    roles: [],
  },
  loft: { tag: "Loft", prefix: [], roles: [], custom: true },
  thicken: {
    tag: "Thicken",
    prefix: [{ kind: "feature" }],
    roles: [{ kind: "dimension", prop: "thickness", dimension: "length" }],
  },
  hole: { tag: "Hole", prefix: [], roles: [], custom: true },
  rib: {
    tag: "Rib",
    prefix: [{ kind: "feature" }, { kind: "sketch", prop: "sketch" }],
    roles: [{ kind: "dimension", prop: "thickness", dimension: "length" }],
  },
  thread: {
    tag: "Thread",
    prefix: [{ kind: "feature" }],
    roles: [
      { kind: "dimension", prop: "majorDiameter", dimension: "length" },
      { kind: "dimension", prop: "pitch", dimension: "length" },
      { kind: "dimension", prop: "length", dimension: "length" },
      { kind: "selector", prop: "mode", mapping: THREAD_MODE },
      { kind: "selector", prop: "handedness", mapping: HANDEDNESS },
      { kind: "selector", prop: "axis", mapping: WORLD_AXIS },
    ],
  },
  helix: { tag: "Helix", prefix: [], roles: [], custom: true },
  scale: {
    tag: "Scale",
    prefix: [{ kind: "feature" }],
    roles: [{ kind: "dimension", prop: "factor", dimension: "dimensionless" }],
  },
  patternLinear: {
    tag: "PatternLinear",
    prefix: [{ kind: "feature" }],
    roles: [
      { kind: "dimension", prop: "count", dimension: "dimensionless" },
      { kind: "dimension", prop: "spacing", dimension: "length" },
      { kind: "dimension", prop: "direction", dimension: "angle", omitWhen: 0 },
    ],
  },
  patternCircular: {
    tag: "PatternCircular",
    prefix: [{ kind: "feature" }],
    roles: [
      { kind: "dimension", prop: "count", dimension: "dimensionless" },
      { kind: "dimension", prop: "totalAngle", dimension: "angle" },
      { kind: "selector", prop: "axis", mapping: WORLD_AXIS },
    ],
  },
  patternPath: {
    tag: "PatternPath",
    prefix: [{ kind: "feature" }, { kind: "sketch", prop: "sketch" }],
    roles: [
      { kind: "dimension", prop: "count", dimension: "dimensionless" },
      { kind: "dimension", prop: "spacing", dimension: "length" },
      {
        kind: "selector",
        prop: "orientation",
        mapping: PATTERN_ORIENTATION,
      },
    ],
  },
  mirror: { tag: "Mirror", prefix: [], roles: [], custom: true },
};

// ---------------------------------------------------------------------------
// The implicit-parameter discipline (mirrored from the compiler)
// ---------------------------------------------------------------------------

/** The payload after the id's first underscore — the compiler's slug source. */
function slugOfId(id: string): string {
  return id.slice(id.indexOf("_") + 1);
}

/** The implicit parameter name (`box-1` + `width` → `box1Width`), verbatim from the compiler. */
function implicitParameterName(slug: string, dimension: string): string {
  const sanitized = slug.replace(/[^A-Za-z0-9_]/g, "");
  const capitalized = dimension.charAt(0).toUpperCase() + dimension.slice(1);
  return `${sanitized}${capitalized}`;
}

/** The standalone output-body name the compiler derives from a slug. */
function standaloneBodyName(slug: string): string {
  return slug.replace(/-/g, " ");
}

// ---------------------------------------------------------------------------
// The plan types (what the walk builds before rendering)
// ---------------------------------------------------------------------------

/** One rendered prop's value. */
type PropValue =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | {
      readonly kind: "vec3";
      readonly x: number;
      readonly y: number;
      readonly z: number;
    }
  | {
      readonly kind: "sections";
      readonly sections: readonly {
        readonly sketch: string;
        readonly z: number | string;
      }[];
    }
  | {
      readonly kind: "points";
      readonly points: readonly { readonly x: number; readonly y: number }[];
    };

/** One rendered prop (name + value), in emit order. */
interface PropPlan {
  readonly name: string;
  readonly value: PropValue;
}

/** A child slot: a nested element or a `<Use>` reference. */
type ChildPlan =
  | { readonly kind: "element"; readonly element: ElementPlan }
  | { readonly kind: "use"; readonly featureId: string };

/** One planned feature element. */
interface ElementPlan {
  /** The JSX tag (`Box`). */
  readonly tag: string;
  /** The feature id, emitted as the `id` prop verbatim. */
  readonly featureId: string;
  /** The props, in emit order (id first). */
  readonly props: PropPlan[];
  /** The children, filled after the DAG pass. */
  children: ChildPlan[];
  /** The `<Body id name>` wrapper, when the output body demands one. */
  readonly bodyWrapper: { readonly id: string; readonly name: string } | null;
  /** The implicit parameters this element's literals re-create, in order. */
  readonly implicitParameters: readonly Parameter[];
}

/** One planned sketch element (entities already validated). */
interface SketchPlan {
  readonly sketchId: string;
  readonly name: string | null;
  readonly workplane: {
    readonly origin: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
    readonly normal: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
    readonly xAxis: {
      readonly x: number;
      readonly y: number;
      readonly z: number;
    };
  };
  readonly entities: readonly {
    readonly tag: string;
    readonly entityId: string;
    readonly props: PropPlan[];
  }[];
}

// ---------------------------------------------------------------------------
// The generator state
// ---------------------------------------------------------------------------

/** Everything the walk accumulates. */
interface GenerateState {
  readonly declines: TsxDeclineNote[];
  /** Parameters by id. */
  readonly parameters: Map<string, Parameter>;
  /** Parameter ids the plan re-creates implicitly (per-feature literals). */
  readonly implicitParameterIds: Set<string>;
  /** Parameter ids declined (not reproducible). */
  readonly declinedParameters: Set<string>;
  /** Bodies by id. */
  readonly bodies: Map<string, Body>;
  /** Body ids declined (display/appearance state, or a declined producer). */
  readonly declinedBodies: Set<string>;
  /** Body ids output by a surviving feature. */
  readonly featureBodies: Set<string>;
  /** Sketch plans by sketch id (declined sketches absent). */
  readonly sketches: Map<string, SketchPlan>;
  /** Sketch ids with no surviving plan. */
  readonly declinedSketches: Set<string>;
  /** Element plans by feature id. */
  readonly elements: Map<string, ElementPlan>;
  /** Feature ids with no surviving plan. */
  readonly declinedFeatures: Set<string>;
}

function decline(
  state: GenerateState,
  kind: string,
  id: string,
  reason: string,
): void {
  state.declines.push({ kind, id, reason });
}

function declineFeature(
  state: GenerateState,
  featureId: string,
  reason: string,
): void {
  decline(state, "feature", featureId, reason);
  state.declinedFeatures.add(featureId);
}

/** Reads a finite number off an unknown record field. */
function finiteNumberOf(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * The canonical-unit magnitude of a value for a dimension, or null when
 * the value's dimension differs or its unit is not the canonical one (a
 * non-canonical quantity cannot be re-authored as a canonical literal).
 */
function canonicalMagnitude(
  value: AnyDimensionalValue,
  dimension: RoleDimension,
): number | null {
  if (value.dimension !== dimension) return null;
  const canonicalUnit = CANONICAL_UNITS[dimension as Dimension];
  if (value.unit !== canonicalUnit) return null;
  return valueIn(value, canonicalUnit);
}

/** Reads a stored workplane vector `{x, y, z}` of finite numbers. */
function storedVec3(
  raw: unknown,
): { readonly x: number; readonly y: number; readonly z: number } | null {
  if (!isPlainRecord(raw)) return null;
  const x = finiteNumberOf(raw.x);
  const y = finiteNumberOf(raw.y);
  const z = finiteNumberOf(raw.z);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

// ---------------------------------------------------------------------------
// Sketch planning
// ---------------------------------------------------------------------------

/** An entity record's id for decline messages (string ids only, "?" otherwise). */
function entityIdOf(entity: Record<string, unknown>): string {
  return typeof entity.id === "string" ? entity.id : "?";
}

/** An entity record's kind for decline messages ("unknown" for non-strings). */
function entityKindOf(entity: Record<string, unknown>): string {
  return typeof entity.kind === "string" ? entity.kind : "unknown";
}

/**
 * Plans one sketch record: validates the payload against the compiler's
 * emission (format version 2, empty constraints, representable entities,
 * the rectangle's chained-lines pattern) or declines the record.
 */
function planSketch(state: GenerateState, record: DocumentSketch): void {
  const payload = record.sketch;
  if (
    payload.formatVersion !== 2 ||
    !isPlainRecord(payload.workplane) ||
    !Array.isArray(payload.entities) ||
    !Array.isArray(payload.constraints) ||
    payload.constraints.length > 0
  ) {
    decline(
      state,
      "sketch",
      record.id,
      "the stored sketch payload is not the compiler's canonical form (format version 2, empty constraints)",
    );
    state.declinedSketches.add(record.id);
    return;
  }
  const origin = storedVec3(payload.workplane.origin);
  const normal = storedVec3(payload.workplane.normal);
  const xAxis = storedVec3(payload.workplane.xAxis);
  if (origin === null || normal === null || xAxis === null) {
    decline(
      state,
      "sketch",
      record.id,
      "the stored workplane frame is not three finite {x, y, z} vectors",
    );
    state.declinedSketches.add(record.id);
    return;
  }
  const entities: {
    readonly tag: string;
    readonly entityId: string;
    readonly props: PropPlan[];
  }[] = [];
  // The rectangle's chained-lines pattern: a rect entity plus the four
  // immediately-preceding line entities the compiler derives from it.
  let index = 0;
  while (index < payload.entities.length) {
    const entity: unknown = payload.entities[index];
    if (!isPlainRecord(entity)) {
      decline(
        state,
        "sketch",
        record.id,
        "an entity record is not a plain object",
      );
      state.declinedSketches.add(record.id);
      return;
    }
    if (entity.construction !== false || entity.fixed !== false) {
      decline(
        state,
        "sketch",
        record.id,
        `the entity "${entityIdOf(entity)}" carries construction/fixed flags the element vocabulary cannot author`,
      );
      state.declinedSketches.add(record.id);
      return;
    }
    if (entity.kind === "rectangle") {
      const planned = planRectangleEntity(entity, payload.entities, index);
      if (planned === null) {
        decline(
          state,
          "sketch",
          record.id,
          `the rectangle entity "${entityIdOf(entity)}" is not the compiler's chained-lines pattern`,
        );
        state.declinedSketches.add(record.id);
        return;
      }
      // The four chained lines just before the rectangle are the
      // compiler's own derivation — the single <Rectangle> re-creates
      // them, so their individual plans fold away.
      entities.splice(entities.length - 4, 4);
      entities.push(planned);
      index += 5;
      continue;
    }
    const planned = planPlainEntity(entity);
    if (planned === null) {
      decline(
        state,
        "sketch",
        record.id,
        `the entity "${entityIdOf(entity)}" (kind ${entityKindOf(entity)}) has no element form`,
      );
      state.declinedSketches.add(record.id);
      return;
    }
    entities.push(planned);
    index += 1;
  }
  const slug = slugOfId(record.id);
  state.sketches.set(record.id, {
    entities,
    name: record.name === standaloneBodyName(slug) ? null : record.name,
    sketchId: record.id,
    workplane: { origin, normal, xAxis },
  });
}

/** The rectangle pattern's expected chained edge, with its derived id. */
interface ExpectedEdge {
  readonly id: string;
  readonly from: readonly [number, number];
  readonly to: readonly [number, number];
}

/** A rectangle entity's plan, or null when the chained pattern does not hold. */
function planRectangleEntity(
  entity: Record<string, unknown>,
  entities: readonly unknown[],
  index: number,
): {
  readonly tag: string;
  readonly entityId: string;
  readonly props: PropPlan[];
} | null {
  const id = entity.id;
  if (typeof id !== "string" || !id.startsWith("skent_")) return null;
  const edges = entity.edges;
  if (!Array.isArray(edges) || edges.length !== 4 || index < 4) return null;
  const slug = id.slice("skent_".length);
  // The rectangle entity carries only its edge references — the corners
  // live on the four chained lines. Derive the canonical frame from them.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let offset = 0; offset < 4; offset += 1) {
    const line = entities[index - 4 + offset];
    if (!isPlainRecord(line) || line.kind !== "line") return null;
    for (const key of ["x1", "x2"] as const) {
      const value = finiteNumberOf(line[key]);
      if (value === null) return null;
      xs.push(value);
    }
    for (const key of ["y1", "y2"] as const) {
      const value = finiteNumberOf(line[key]);
      if (value === null) return null;
      ys.push(value);
    }
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  if (minX === maxX || minY === maxY) return null;
  // The compiler's canonical corners (bottom, right, top, left) and ids.
  const expected: readonly ExpectedEdge[] = [
    { id: `skent_${slug}-bottom`, from: [minX, minY], to: [maxX, minY] },
    { id: `skent_${slug}-right`, from: [maxX, minY], to: [maxX, maxY] },
    { id: `skent_${slug}-top`, from: [maxX, maxY], to: [minX, maxY] },
    { id: `skent_${slug}-left`, from: [minX, maxY], to: [minX, minY] },
  ];
  for (let offset = 0; offset < 4; offset += 1) {
    const line = entities[index - 4 + offset];
    if (!isPlainRecord(line)) return null;
    const want = expected[offset];
    if (want === undefined) return null;
    if (line.id !== want.id) return null;
    if (
      finiteNumberOf(line.x1) !== want.from[0] ||
      finiteNumberOf(line.y1) !== want.from[1] ||
      finiteNumberOf(line.x2) !== want.to[0] ||
      finiteNumberOf(line.y2) !== want.to[1]
    ) {
      return null;
    }
    if (edges[offset] !== want.id) return null;
  }
  return {
    entityId: id,
    props: [
      { name: "id", value: { kind: "string", value: id } },
      { name: "x1", value: { kind: "number", value: minX } },
      { name: "y1", value: { kind: "number", value: minY } },
      { name: "x2", value: { kind: "number", value: maxX } },
      { name: "y2", value: { kind: "number", value: maxY } },
    ],
    tag: "Rectangle",
  };
}

/** A non-rectangle entity's plan, or null when it has no element form. */
function planPlainEntity(entity: Record<string, unknown>): {
  readonly tag: string;
  readonly entityId: string;
  readonly props: PropPlan[];
} | null {
  const id = entity.id;
  if (typeof id !== "string" || !id.startsWith("skent_")) return null;
  const idProp: PropPlan = { name: "id", value: { kind: "string", value: id } };
  const numberProp = (name: string): PropPlan | null => {
    const value = finiteNumberOf(entity[name]);
    return value === null ? null : { name, value: { kind: "number", value } };
  };
  const allNumbers = (names: readonly string[]): PropPlan[] | null => {
    const props = names.map(numberProp);
    return props.some((prop) => prop === null) ? null : (props as PropPlan[]);
  };
  switch (entity.kind) {
    case "point":
    case "line": {
      const props = allNumbers(
        entity.kind === "point" ? ["x", "y"] : ["x1", "y1", "x2", "y2"],
      );
      return props === null
        ? null
        : {
            entityId: id,
            props: [idProp, ...props],
            tag: entity.kind === "point" ? "Point" : "Line",
          };
    }
    case "circle":
    case "arc": {
      const props = allNumbers(
        entity.kind === "arc"
          ? ["cx", "cy", "radius", "startAngle", "endAngle"]
          : ["cx", "cy", "radius"],
      );
      return props === null
        ? null
        : {
            entityId: id,
            props: [idProp, ...props],
            tag: entity.kind === "arc" ? "Arc" : "Circle",
          };
    }
    case "ellipse": {
      const props = allNumbers(["cx", "cy", "radiusX", "radiusY"]);
      if (props === null) return null;
      const rotation = finiteNumberOf(entity.rotation) ?? 0;
      return {
        entityId: id,
        props:
          rotation === 0
            ? [idProp, ...props]
            : [
                ...[idProp, ...props],
                {
                  name: "rotation",
                  value: { kind: "number", value: rotation },
                },
              ],
        tag: "Ellipse",
      };
    }
    case "slot": {
      if (entity.variant !== "straight" && entity.variant !== "arc3") {
        return null;
      }
      const props = allNumbers(["x1", "y1", "x2", "y2"]);
      if (props === null) return null;
      const listed: PropPlan[] = [
        idProp,
        { name: "variant", value: { kind: "string", value: entity.variant } },
        ...props,
      ];
      if (entity.variant === "arc3") {
        const x3 = numberProp("x3");
        const y3 = numberProp("y3");
        if (x3 === null || y3 === null) return null;
        listed.push(x3, y3);
      }
      const radius = numberProp("radius");
      if (radius === null) return null;
      listed.push(radius);
      return { entityId: id, props: listed, tag: "Slot" };
    }
    case "polygon": {
      if (entity.fit !== "inscribed" && entity.fit !== "circumscribed") {
        return null;
      }
      const sides = entity.sides;
      if (
        typeof sides !== "number" ||
        !Number.isInteger(sides) ||
        sides < 3 ||
        sides > 128
      ) {
        return null;
      }
      const props = allNumbers(["cx", "cy", "radius"]);
      if (props === null) return null;
      const listed: PropPlan[] = [
        idProp,
        ...props,
        { name: "sides", value: { kind: "number", value: sides } },
      ];
      const rotation = finiteNumberOf(entity.rotation) ?? 0;
      if (rotation !== 0) {
        listed.push({
          name: "rotation",
          value: { kind: "number", value: rotation },
        });
      }
      listed.push({
        name: "fit",
        value: { kind: "string", value: entity.fit },
      });
      return { entityId: id, props: listed, tag: "Polygon" };
    }
    case "spline": {
      if (entity.flavor !== "control" && entity.flavor !== "interpolated") {
        return null;
      }
      const rawPoints = entity.points;
      if (!Array.isArray(rawPoints) || rawPoints.length < 2) return null;
      const points: { readonly x: number; readonly y: number }[] = [];
      for (const rawPoint of rawPoints) {
        if (!isPlainRecord(rawPoint)) return null;
        const x = finiteNumberOf(rawPoint.x);
        const y = finiteNumberOf(rawPoint.y);
        if (x === null || y === null) return null;
        points.push({ x, y });
      }
      return {
        entityId: id,
        props: [
          idProp,
          { name: "flavor", value: { kind: "string", value: entity.flavor } },
          { name: "points", value: { kind: "points", points } },
        ],
        tag: "Spline",
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Feature planning
// ---------------------------------------------------------------------------

/** Reads inputs[index] or declines the feature for a missing slot. */
function inputAt(
  state: GenerateState,
  feature: FeatureRecord,
  inputs: readonly FeatureInputRef[],
  index: number,
): FeatureInputRef | null {
  const input = inputs[index];
  if (input === undefined) {
    declineFeature(
      state,
      feature.id,
      `the input layout is shorter than the compiler's ${feature.kind} form`,
    );
    return null;
  }
  return input;
}

/** Declines a feature for an input slot of the wrong record kind. */
function declineWrongInputKind(
  state: GenerateState,
  feature: FeatureRecord,
  input: FeatureInputRef,
  expected: string,
): void {
  declineFeature(
    state,
    feature.id,
    `the input "${input.id}" (${input.kind}) does not fill the ${expected} slot of the compiler's ${feature.kind} form`,
  );
}

/** The mutable accumulators one feature's plan builds through. */
interface FeatureAccumulators {
  readonly props: PropPlan[];
  readonly implicitParameters: Parameter[];
  readonly consumedFeatures: string[];
}

/** Notes one parameter input as this feature's implicit literal, when it is. */
function noteImplicit(
  state: GenerateState,
  input: FeatureInputRef,
  accumulators: FeatureAccumulators,
): void {
  if (input.kind !== "parameter" || !state.implicitParameterIds.has(input.id)) {
    return;
  }
  const parameter = state.parameters.get(input.id);
  if (parameter !== undefined) accumulators.implicitParameters.push(parameter);
}

/**
 * Resolves one parameter input to a prop value: a literal when the
 * parameter is this feature's own implicit parameter (id and name both
 * match the compiler's derivation), a parameter-id string reference
 * otherwise. Null declines the feature.
 */
function parameterProp(
  state: GenerateState,
  feature: FeatureRecord,
  input: FeatureInputRef,
  prop: string,
  dimension: RoleDimension,
):
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | null {
  if (input.kind !== "parameter") {
    declineWrongInputKind(state, feature, input, `"${prop}" parameter`);
    return null;
  }
  const parameter = state.parameters.get(input.id);
  if (parameter === undefined) {
    declineFeature(
      state,
      feature.id,
      `the "${prop}" input references parameter "${input.id}", which is not a record of this document`,
    );
    return null;
  }
  if (state.declinedParameters.has(input.id)) {
    declineFeature(
      state,
      feature.id,
      `the "${prop}" input references parameter "${input.id}", which is not representable (see its decline)`,
    );
    return null;
  }
  const slug = slugOfId(feature.id);
  if (
    input.id === `param_${slug}-${prop}` &&
    parameter.name === implicitParameterName(slug, prop)
  ) {
    const magnitude = canonicalMagnitude(parameter.value, dimension);
    if (magnitude === null) {
      declineFeature(
        state,
        feature.id,
        `the implicit parameter "${input.id}" carries a value outside the canonical unit of its dimension and cannot be re-authored as a literal`,
      );
      return null;
    }
    state.implicitParameterIds.add(input.id);
    return { kind: "number", value: magnitude };
  }
  // A reference to a parameter declared elsewhere: it must still be
  // declarable (canonical unit) for the generated <Parameter> to reproduce.
  if (
    canonicalMagnitude(
      parameter.value,
      parameter.value.dimension as RoleDimension,
    ) === null
  ) {
    declineFeature(
      state,
      feature.id,
      `the "${prop}" input references parameter "${input.id}", whose value is outside the canonical unit of its dimension`,
    );
    return null;
  }
  return { kind: "string", value: input.id };
}

/** Resolves one selector parameter input to its enum string. */
function selectorProp(
  state: GenerateState,
  feature: FeatureRecord,
  input: FeatureInputRef,
  prop: string,
  mapping: Readonly<Record<string, number>>,
): { readonly kind: "string"; readonly value: string } | null {
  if (input.kind !== "parameter") {
    declineWrongInputKind(state, feature, input, `"${prop}" selector`);
    return null;
  }
  const literal = parameterProp(state, feature, input, prop, "dimensionless");
  if (literal === null) return null;
  if (literal.kind === "string") {
    declineFeature(
      state,
      feature.id,
      `the "${prop}" selector input references parameter "${literal.value}" — the element's ${prop} prop accepts the enum value only`,
    );
    return null;
  }
  const entry = Object.keys(mapping).find(
    (key) => mapping[key] === literal.value,
  );
  if (entry === undefined) {
    declineFeature(
      state,
      feature.id,
      `the "${prop}" selector value (${String(literal.value)}) is not one of the bridge's selector constants`,
    );
    return null;
  }
  return { kind: "string", value: entry };
}

/** Takes one sketch input, pushing its prop; null declines the feature. */
function takeSketch(
  state: GenerateState,
  feature: FeatureRecord,
  input: FeatureInputRef,
  prop: string,
  accumulators: FeatureAccumulators,
): boolean {
  if (input.kind !== "sketch") {
    declineWrongInputKind(state, feature, input, `"${prop}" sketch`);
    return false;
  }
  if (state.declinedSketches.has(input.id) || !state.sketches.has(input.id)) {
    declineFeature(
      state,
      feature.id,
      `the "${prop}" input references sketch "${input.id}", which is not representable (see its decline)`,
    );
    return false;
  }
  accumulators.props.push({
    name: prop,
    value: { kind: "string", value: input.id },
  });
  return true;
}

/** Takes one feature input into the children accumulator. */
function takeFeatureInput(
  state: GenerateState,
  feature: FeatureRecord,
  input: FeatureInputRef,
  accumulators: FeatureAccumulators,
): boolean {
  if (input.kind !== "feature") {
    declineWrongInputKind(state, feature, input, "target feature");
    return false;
  }
  accumulators.consumedFeatures.push(input.id);
  return true;
}

/**
 * Plans one feature record against the compiler's inverse table. Marks
 * declines in state; a planned element lands in `state.elements`.
 */
function planFeature(state: GenerateState, feature: FeatureRecord): void {
  const layout = KIND_LAYOUTS[feature.kind];
  if (layout === undefined) {
    declineFeature(
      state,
      feature.id,
      `the feature kind "${feature.kind}" has no element in the @slopcad/cad-jsx vocabulary`,
    );
    return;
  }
  if (feature.outputs.length !== 1 || feature.outputs[0] === undefined) {
    declineFeature(
      state,
      feature.id,
      "the feature does not output exactly one body (the compiler's element form always does)",
    );
    return;
  }
  const outputBodyId: string = feature.outputs[0];
  const outputBody = state.bodies.get(outputBodyId);
  if (outputBody === undefined) {
    declineFeature(
      state,
      feature.id,
      `the output body "${outputBodyId}" is not a record of this document`,
    );
    return;
  }
  if (state.declinedBodies.has(outputBodyId)) {
    declineFeature(
      state,
      feature.id,
      `the output body "${outputBodyId}" carries display/appearance state the element vocabulary cannot author (see its decline)`,
    );
    return;
  }
  const accumulators: FeatureAccumulators = {
    consumedFeatures: [],
    implicitParameters: [],
    props: [{ name: "id", value: { kind: "string", value: feature.id } }],
  };
  const inputs = feature.inputs;
  const ok =
    layout.custom === true
      ? planCustomKind(state, feature, layout.tag, inputs, accumulators)
      : planTableKind(state, feature, layout, inputs, accumulators);
  if (!ok) return;
  state.featureBodies.add(outputBodyId);
  const slug = slugOfId(feature.id);
  state.elements.set(feature.id, {
    bodyWrapper:
      outputBody.name === standaloneBodyName(slug)
        ? null
        : { id: outputBodyId, name: outputBody.name },
    children: [],
    featureId: feature.id,
    implicitParameters: accumulators.implicitParameters,
    props: accumulators.props,
    tag: layout.tag,
  });
}

/** The table-driven forms: prefix slots, then the parameter tail. */
function planTableKind(
  state: GenerateState,
  feature: FeatureRecord,
  layout: KindLayout,
  inputs: readonly FeatureInputRef[],
  accumulators: FeatureAccumulators,
): boolean {
  let index = 0;
  for (const slot of layout.prefix) {
    if (slot.kind === "feature") {
      const input = inputAt(state, feature, inputs, index);
      if (input === null) return false;
      if (!takeFeatureInput(state, feature, input, accumulators)) return false;
      index += 1;
      continue;
    }
    if (slot.kind === "features") {
      const consumed: string[] = [];
      while (index < inputs.length && inputs[index]?.kind === "feature") {
        const input = inputs[index];
        if (input === undefined) break;
        consumed.push(input.id);
        index += 1;
      }
      if (consumed.length < slot.min) {
        declineFeature(
          state,
          feature.id,
          `the boolean form needs at least ${String(slot.min)} feature inputs; the record declares ${String(consumed.length)}`,
        );
        return false;
      }
      accumulators.consumedFeatures.push(...consumed);
      continue;
    }
    const input = inputAt(state, feature, inputs, index);
    if (input === null) return false;
    if (!takeSketch(state, feature, input, slot.prop, accumulators)) {
      return false;
    }
    index += 1;
  }
  for (const role of layout.roles) {
    const input = inputAt(state, feature, inputs, index);
    if (input === null) return false;
    if (role.kind === "selector") {
      const value = selectorProp(
        state,
        feature,
        input,
        role.prop,
        role.mapping,
      );
      if (value === null) return false;
      noteImplicit(state, input, accumulators);
      index += 1;
      if (value.value === roleDefault(role)) continue;
      accumulators.props.push({ name: role.prop, value });
      continue;
    }
    const value = parameterProp(
      state,
      feature,
      input,
      role.prop,
      role.dimension,
    );
    if (value === null) return false;
    noteImplicit(state, input, accumulators);
    index += 1;
    if (
      value.kind === "number" &&
      role.omitWhen !== undefined &&
      value.value === role.omitWhen
    ) {
      continue;
    }
    accumulators.props.push({ name: role.prop, value });
  }
  if (index !== inputs.length) {
    declineFeature(
      state,
      feature.id,
      `the input layout is longer than the compiler's ${feature.kind} form (${String(inputs.length)} inputs)`,
    );
    return false;
  }
  return true;
}

/** The selector prop's compile-time default (`z`, `external`, …). */
const SELECTOR_DEFAULTS: Readonly<Record<string, string>> = {
  axis: "z",
  mode: "external",
  handedness: "right",
  orientation: "fixed",
  plane: "z",
};

function roleDefault(role: SelectorRole): string | undefined {
  return SELECTOR_DEFAULTS[role.prop];
}

/** The custom forms: extrude, revolve, loft, hole, helix, mirror. */
function planCustomKind(
  state: GenerateState,
  feature: FeatureRecord,
  tag: string,
  inputs: readonly FeatureInputRef[],
  accumulators: FeatureAccumulators,
): boolean {
  switch (tag) {
    case "Extrude":
      return planExtrude(state, feature, inputs, accumulators);
    case "Revolve":
      return planRevolve(state, feature, inputs, accumulators);
    case "Loft":
      return planLoft(state, feature, inputs, accumulators);
    case "Hole":
      return planHole(state, feature, inputs, accumulators);
    case "Helix":
      return planHelix(state, feature, inputs, accumulators);
    case "Mirror":
      return planMirror(state, feature, inputs, accumulators);
    default:
      declineFeature(
        state,
        feature.id,
        `the feature kind "${feature.kind}" has no custom form`,
      );
      return false;
  }
}

/** `[sketch, signed height, taper?]` — a negative height folds into `direction={-1}`. */
function planExtrude(
  state: GenerateState,
  feature: FeatureRecord,
  inputs: readonly FeatureInputRef[],
  accumulators: FeatureAccumulators,
): boolean {
  const sketchInput = inputAt(state, feature, inputs, 0);
  if (sketchInput === null) return false;
  if (!takeSketch(state, feature, sketchInput, "sketch", accumulators)) {
    return false;
  }
  const heightInput = inputAt(state, feature, inputs, 1);
  if (heightInput === null) return false;
  const height = parameterProp(state, feature, heightInput, "height", "length");
  if (height === null) return false;
  noteImplicit(state, heightInput, accumulators);
  if (height.kind === "number" && height.value < 0) {
    accumulators.props.push({
      name: "height",
      value: { kind: "number", value: Math.abs(height.value) },
    });
    accumulators.props.push({
      name: "direction",
      value: { kind: "number", value: -1 },
    });
  } else {
    accumulators.props.push({ name: "height", value: height });
  }
  const taperInput = inputs[2];
  if (taperInput === undefined) {
    if (inputs.length !== 2) {
      declineFeature(
        state,
        feature.id,
        "the input layout is not the compiler's extrude form",
      );
      return false;
    }
    return true;
  }
  const taper = parameterProp(state, feature, taperInput, "taper", "angle");
  if (taper === null) return false;
  noteImplicit(state, taperInput, accumulators);
  accumulators.props.push({ name: "taper", value: taper });
  if (inputs.length !== 3) {
    declineFeature(
      state,
      feature.id,
      "the input layout is not the compiler's extrude form",
    );
    return false;
  }
  return true;
}

/** `[sketch, angle, axis-parameter]` — the datum-axis form declines with the datum. */
function planRevolve(
  state: GenerateState,
  feature: FeatureRecord,
  inputs: readonly FeatureInputRef[],
  accumulators: FeatureAccumulators,
): boolean {
  const sketchInput = inputAt(state, feature, inputs, 0);
  if (sketchInput === null) return false;
  if (!takeSketch(state, feature, sketchInput, "sketch", accumulators)) {
    return false;
  }
  const angleInput = inputAt(state, feature, inputs, 1);
  if (angleInput === null) return false;
  const angle = parameterProp(state, feature, angleInput, "angle", "angle");
  if (angle === null) return false;
  noteImplicit(state, angleInput, accumulators);
  accumulators.props.push({ name: "angle", value: angle });
  const axisInput = inputAt(state, feature, inputs, 2);
  if (axisInput === null) return false;
  if (axisInput.kind === "datum") {
    declineWrongInputKind(state, feature, axisInput, "in-plane axis parameter");
    return false;
  }
  const axis = parameterProp(state, feature, axisInput, "axis", "angle");
  if (axis === null) return false;
  noteImplicit(state, axisInput, accumulators);
  // The compiler's default axis parameter (0 rad) re-creates itself.
  if (!(axis.kind === "number" && axis.value === 0)) {
    accumulators.props.push({ name: "axis", value: axis });
  }
  if (inputs.length !== 3) {
    declineFeature(
      state,
      feature.id,
      "the input layout is not the compiler's revolve form",
    );
    return false;
  }
  return true;
}

/** `[sketch, stationZ1, sketch, stationZ2, …]` — at least two sections. */
function planLoft(
  state: GenerateState,
  feature: FeatureRecord,
  inputs: readonly FeatureInputRef[],
  accumulators: FeatureAccumulators,
): boolean {
  const sections: {
    readonly sketch: string;
    readonly z: number | string;
  }[] = [];
  let index = 0;
  while (index < inputs.length) {
    const sketchInput = inputs[index];
    if (sketchInput === undefined || sketchInput.kind !== "sketch") {
      declineFeature(
        state,
        feature.id,
        "the input layout is not the compiler's interleaved loft form",
      );
      return false;
    }
    if (
      state.declinedSketches.has(sketchInput.id) ||
      !state.sketches.has(sketchInput.id)
    ) {
      declineFeature(
        state,
        feature.id,
        `a section references sketch "${sketchInput.id}", which is not representable (see its decline)`,
      );
      return false;
    }
    const stationInput = inputs[index + 1];
    if (stationInput === undefined || stationInput.kind !== "parameter") {
      declineFeature(
        state,
        feature.id,
        "the input layout is not the compiler's interleaved loft form",
      );
      return false;
    }
    const station = parameterProp(
      state,
      feature,
      stationInput,
      `stationZ${String(sections.length + 1)}`,
      "length",
    );
    if (station === null) return false;
    noteImplicit(state, stationInput, accumulators);
    sections.push({
      sketch: sketchInput.id,
      z: station.value,
    });
    index += 2;
  }
  if (sections.length < 2) {
    declineFeature(
      state,
      feature.id,
      "the loft carries fewer than the two sections the compiler demands",
    );
    return false;
  }
  accumulators.props.push({
    name: "sections",
    value: { kind: "sections", sections },
  });
  return true;
}

/**
 * The hole's two forms, dispatched like the compiler: the structured form
 * when the second input is the type selector (which the compiler always
 * creates as this feature's implicit parameter — the type prop accepts
 * the enum only, never a reference), the flat five-parameter form
 * otherwise. The axis datum alternative declines with the datum.
 */
function planHole(
  state: GenerateState,
  feature: FeatureRecord,
  inputs: readonly FeatureInputRef[],
  accumulators: FeatureAccumulators,
): boolean {
  const targetInput = inputAt(state, feature, inputs, 0);
  if (targetInput === null) return false;
  if (!takeFeatureInput(state, feature, targetInput, accumulators)) {
    return false;
  }
  const second = inputAt(state, feature, inputs, 1);
  if (second === null) return false;
  const slug = slugOfId(feature.id);
  const structured =
    second.kind === "parameter" &&
    second.id === `param_${slug}-type` &&
    state.parameters.get(second.id)?.name ===
      implicitParameterName(slug, "type");
  if (structured) {
    const typeValue = selectorProp(state, feature, second, "type", HOLE_TYPE);
    if (typeValue === null) return false;
    if (!Object.hasOwn(HOLE_TYPE_ROLES, typeValue.value)) {
      declineFeature(
        state,
        feature.id,
        `the hole's type selector value ("${typeValue.value}") has no role list`,
      );
      return false;
    }
    // The structured form: type, the type's roles, the positions slot, axis.
    noteImplicit(state, second, accumulators);
    accumulators.props.push({ name: "type", value: typeValue });
    const roles = HOLE_TYPE_ROLES[typeValue.value] ?? [];
    let index = 2;
    for (const role of roles) {
      const input = inputAt(state, feature, inputs, index);
      if (input === null) return false;
      const value = parameterProp(
        state,
        feature,
        input,
        role.prop,
        role.dimension,
      );
      if (value === null) return false;
      noteImplicit(state, input, accumulators);
      accumulators.props.push({ name: role.prop, value });
      index += 1;
    }
    const positions = inputAt(state, feature, inputs, index);
    if (positions === null) return false;
    if (positions.kind === "sketch") {
      if (!takeSketch(state, feature, positions, "positions", accumulators)) {
        return false;
      }
      index += 1;
    } else {
      for (const role of [
        { prop: "positionX", dimension: "length" },
        { prop: "positionY", dimension: "length" },
      ] as const) {
        const input = inputAt(state, feature, inputs, index);
        if (input === null) return false;
        const value = parameterProp(
          state,
          feature,
          input,
          role.prop,
          role.dimension,
        );
        if (value === null) return false;
        noteImplicit(state, input, accumulators);
        accumulators.props.push({ name: role.prop, value });
        index += 1;
      }
    }
    return holeAxisTail(state, feature, inputs, index, accumulators);
  }
  // The flat form: diameter, depth, positionX, positionY, then the axis.
  const diameter = parameterProp(state, feature, second, "diameter", "length");
  if (diameter === null) return false;
  noteImplicit(state, second, accumulators);
  accumulators.props.push({ name: "diameter", value: diameter });
  let index = 2;
  for (const role of [
    { prop: "depth", dimension: "length" },
    { prop: "positionX", dimension: "length" },
    { prop: "positionY", dimension: "length" },
  ] as const) {
    const input = inputAt(state, feature, inputs, index);
    if (input === null) return false;
    const value = parameterProp(
      state,
      feature,
      input,
      role.prop,
      role.dimension,
    );
    if (value === null) return false;
    noteImplicit(state, input, accumulators);
    accumulators.props.push({ name: role.prop, value });
    index += 1;
  }
  return holeAxisTail(state, feature, inputs, index, accumulators);
}

/** The hole forms' shared axis tail (the datum alternative declines). */
function holeAxisTail(
  state: GenerateState,
  feature: FeatureRecord,
  inputs: readonly FeatureInputRef[],
  index: number,
  accumulators: FeatureAccumulators,
): boolean {
  const axisInput = inputAt(state, feature, inputs, index);
  if (axisInput === null) return false;
  if (axisInput.kind === "datum") {
    declineWrongInputKind(state, feature, axisInput, "world-axis selector");
    return false;
  }
  const axis = selectorProp(state, feature, axisInput, "axis", WORLD_AXIS);
  if (axis === null) return false;
  noteImplicit(state, axisInput, accumulators);
  // The compiler's default axis selector ("z") re-creates itself.
  if (axis.value !== "z") {
    accumulators.props.push({ name: "axis", value: axis });
  }
  if (inputs.length !== index + 1) {
    declineFeature(
      state,
      feature.id,
      "the input layout is longer than the compiler's hole form",
    );
    return false;
  }
  return true;
}

/** `[sketch, radius, pitch, turns, handedness, startAngle, taper]` (+ optional datum axis, which declines). */
function planHelix(
  state: GenerateState,
  feature: FeatureRecord,
  inputs: readonly FeatureInputRef[],
  accumulators: FeatureAccumulators,
): boolean {
  const sketchInput = inputAt(state, feature, inputs, 0);
  if (sketchInput === null) return false;
  if (!takeSketch(state, feature, sketchInput, "sketch", accumulators)) {
    return false;
  }
  let index = 1;
  for (const role of [
    { prop: "radius", dimension: "length" },
    { prop: "pitch", dimension: "length" },
    { prop: "turns", dimension: "dimensionless" },
  ] as const) {
    const input = inputAt(state, feature, inputs, index);
    if (input === null) return false;
    const value = parameterProp(
      state,
      feature,
      input,
      role.prop,
      role.dimension,
    );
    if (value === null) return false;
    noteImplicit(state, input, accumulators);
    accumulators.props.push({ name: role.prop, value });
    index += 1;
  }
  const handednessInput = inputAt(state, feature, inputs, index);
  if (handednessInput === null) return false;
  const handedness = selectorProp(
    state,
    feature,
    handednessInput,
    "handedness",
    HANDEDNESS,
  );
  if (handedness === null) return false;
  noteImplicit(state, handednessInput, accumulators);
  // The compiler's default handedness ("right") re-creates itself.
  if (handedness.value !== "right") {
    accumulators.props.push({ name: "handedness", value: handedness });
  }
  index += 1;
  for (const role of [
    { prop: "startAngle", dimension: "angle", omitWhen: 0 },
    { prop: "taper", dimension: "length", omitWhen: 0 },
  ] as const) {
    const input = inputAt(state, feature, inputs, index);
    if (input === null) return false;
    const value = parameterProp(
      state,
      feature,
      input,
      role.prop,
      role.dimension,
    );
    if (value === null) return false;
    noteImplicit(state, input, accumulators);
    index += 1;
    if (value.kind === "number" && value.value === role.omitWhen) continue;
    accumulators.props.push({ name: role.prop, value });
  }
  if (index === inputs.length) return true;
  const axis = inputs[index];
  if (axis === undefined || axis.kind !== "datum") {
    declineFeature(
      state,
      feature.id,
      "the input layout is not the compiler's helix form",
    );
    return false;
  }
  declineWrongInputKind(state, feature, axis, "optional datum axis");
  return false;
}

/** `[feature, plane-selector, offset]` — the datum-plane form declines with the datum. */
function planMirror(
  state: GenerateState,
  feature: FeatureRecord,
  inputs: readonly FeatureInputRef[],
  accumulators: FeatureAccumulators,
): boolean {
  const targetInput = inputAt(state, feature, inputs, 0);
  if (targetInput === null) return false;
  if (!takeFeatureInput(state, feature, targetInput, accumulators)) {
    return false;
  }
  const planeInput = inputAt(state, feature, inputs, 1);
  if (planeInput === null) return false;
  if (planeInput.kind === "datum") {
    declineWrongInputKind(
      state,
      feature,
      planeInput,
      "world-axis plane selector",
    );
    return false;
  }
  const plane = selectorProp(state, feature, planeInput, "plane", WORLD_AXIS);
  if (plane === null) return false;
  noteImplicit(state, planeInput, accumulators);
  accumulators.props.push({ name: "plane", value: plane });
  const offsetInput = inputAt(state, feature, inputs, 2);
  if (offsetInput === null) return false;
  const offset = parameterProp(state, feature, offsetInput, "offset", "length");
  if (offset === null) return false;
  noteImplicit(state, offsetInput, accumulators);
  // The compiler's default offset (0 mm) re-creates itself; a parameter
  // reference must stay visible.
  if (offset.kind === "string" || offset.value !== 0) {
    accumulators.props.push({ name: "offset", value: offset });
  }
  if (inputs.length !== 3) {
    declineFeature(
      state,
      feature.id,
      "the input layout is not the compiler's mirror form",
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Deterministic number rendering (round-trippable decimal form). */
function renderNumber(value: number): string {
  return JSON.stringify(value);
}

/** Renders one prop value expression (without the surrounding braces). */
function renderValue(value: PropValue, indent: number): string {
  const pad = " ".repeat(indent);
  switch (value.kind) {
    case "number":
      return renderNumber(value.value);
    case "string":
      return JSON.stringify(value.value);
    case "vec3":
      return `{\n${pad}  x: ${renderNumber(value.x)},\n${pad}  y: ${renderNumber(value.y)},\n${pad}  z: ${renderNumber(value.z)},\n${pad}}`;
    case "points":
      return `[\n${value.points
        .map(
          (point) =>
            `${pad}  { x: ${renderNumber(point.x)}, y: ${renderNumber(point.y)} },`,
        )
        .join("\n")}\n${pad}]`;
    case "sections":
      return `[\n${value.sections
        .map(
          (section) =>
            `${pad}  { sketch: ${JSON.stringify(section.sketch)}, z: ${
              typeof section.z === "number"
                ? renderNumber(section.z)
                : JSON.stringify(section.z)
            } },`,
        )
        .join("\n")}\n${pad}]`;
  }
}

/** Renders one element (with its children, recursively). */
function renderElement(
  element: ElementPlan,
  indent: number,
  lines: string[],
): void {
  const pad = " ".repeat(indent);
  const props = element.props
    .map((prop) => `${prop.name}={${renderValue(prop.value, indent + 4)}}`)
    .join(" ");
  const open = `${pad}<${element.tag}${props === "" ? "" : ` ${props}`}`;
  if (element.bodyWrapper !== null) {
    lines.push(
      `${pad}<Body id={${JSON.stringify(element.bodyWrapper.id)}} name={${JSON.stringify(element.bodyWrapper.name)}}>`,
    );
  }
  if (element.children.length === 0) {
    lines.push(`${open} />`);
  } else {
    lines.push(`${open}>`);
    for (const child of element.children) {
      if (child.kind === "use") {
        lines.push(
          `${pad}  <Use feature={${JSON.stringify(child.featureId)}} />`,
        );
      } else {
        renderElement(child.element, indent + 2, lines);
      }
    }
    lines.push(`${pad}</${element.tag}>`);
  }
  if (element.bodyWrapper !== null) {
    lines.push(`${pad}</Body>`);
  }
}

/** Renders one sketch element with its entity children. */
function renderSketch(
  sketch: SketchPlan,
  indent: number,
  lines: string[],
): void {
  const pad = " ".repeat(indent);
  const { origin, normal, xAxis } = sketch.workplane;
  const props = [
    `id={${JSON.stringify(sketch.sketchId)}}`,
    ...(sketch.name === null ? [] : [`name={${JSON.stringify(sketch.name)}}`]),
    ...(isDefaultVec(origin, 0, 0, 0)
      ? []
      : [
          `origin={${renderValue(
            { kind: "vec3", x: origin.x, y: origin.y, z: origin.z },
            indent + 4,
          )}}`,
        ]),
    ...(isDefaultVec(normal, 0, 0, 1)
      ? []
      : [
          `normal={${renderValue(
            { kind: "vec3", x: normal.x, y: normal.y, z: normal.z },
            indent + 4,
          )}}`,
        ]),
    ...(isDefaultVec(xAxis, 1, 0, 0)
      ? []
      : [
          `xAxis={${renderValue(
            { kind: "vec3", x: xAxis.x, y: xAxis.y, z: xAxis.z },
            indent + 4,
          )}}`,
        ]),
  ].join(" ");
  if (sketch.entities.length === 0) {
    lines.push(`${pad}<Sketch ${props} />`);
    return;
  }
  lines.push(`${pad}<Sketch ${props}>`);
  for (const entity of sketch.entities) {
    const entityProps = entity.props
      .map((prop) => `${prop.name}={${renderValue(prop.value, indent + 4)}}`)
      .join(" ");
    lines.push(`${pad}  <${entity.tag} ${entityProps} />`);
  }
  lines.push(`${pad}</Sketch>`);
}

/** True when a stored frame vector equals the compiler's default. */
function isDefaultVec(
  value: { readonly x: number; readonly y: number; readonly z: number },
  x: number,
  y: number,
  z: number,
): boolean {
  return value.x === x && value.y === y && value.z === z;
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * Generates TSX source that reproduces `document` when compiled through
 * this package's canonical loader discipline. Pure and deterministic;
 * declines are returned as data (and listed in the header comment), never
 * silently dropped. Fails only when the document's own creation order
 * cannot be reproduced by the canonical form (see the module header).
 */
export function generateTsx(
  document: CadDocument,
  options: GenerateTsxOptions = {},
): ParseResult<GeneratedTsx, TsxGenerateError> {
  const state: GenerateState = {
    bodies: new Map(document.bodies.map((body) => [body.id, body])),
    declines: [],
    declinedBodies: new Set(),
    declinedFeatures: new Set(),
    declinedParameters: new Set(),
    declinedSketches: new Set(),
    elements: new Map(),
    featureBodies: new Set(),
    implicitParameterIds: new Set(),
    parameters: new Map(
      document.parameters.parameters.map((parameter) => [
        parameter.id,
        parameter,
      ]),
    ),
    sketches: new Map(),
  };

  // 1. Record families with no JSX form at all.
  for (const section of document.sections) {
    decline(
      state,
      "section",
      section.id,
      "section display records have no element in the JSX vocabulary",
    );
  }
  for (const occurrence of document.occurrences) {
    decline(
      state,
      "occurrence",
      occurrence.id,
      "assembly occurrence records have no element in the JSX vocabulary",
    );
  }
  for (const mate of document.mates) {
    decline(
      state,
      "mate",
      mate.id,
      "assembly mate records have no element in the JSX vocabulary",
    );
  }
  for (const joint of document.joints) {
    decline(
      state,
      "joint",
      joint.id,
      "assembly joint records have no element in the JSX vocabulary",
    );
  }
  for (const configuration of document.configurations) {
    decline(
      state,
      "configuration",
      configuration.id,
      "configuration rows have no element in the JSX vocabulary (the parameters reproduce; the row set does not)",
    );
  }
  for (const datum of document.datums) {
    decline(
      state,
      "datum",
      datum.id,
      "datum records are addressed by id in the vocabulary, never declared — a fresh compile cannot create them",
    );
  }
  for (const curve of document.curves) {
    decline(
      state,
      "curve",
      curve.id,
      "curve records are addressed by id in the vocabulary, never declared — a fresh compile cannot create them",
    );
  }
  for (const reference of document.references) {
    decline(
      state,
      "reference",
      reference.id,
      "persistent-reference records are minted by the picking layer, never declared — a fresh compile cannot create them",
    );
  }

  // 2. Parameters: only plain literal parameters (no expression, no
  //    metadata, canonical unit) are representable.
  for (const parameter of document.parameters.parameters) {
    if (
      parameter.expression !== null ||
      Object.keys(parameter.metadata).length > 0 ||
      canonicalMagnitude(
        parameter.value,
        parameter.value.dimension as RoleDimension,
      ) === null
    ) {
      decline(
        state,
        "parameter",
        parameter.id,
        parameter.expression !== null
          ? "the parameter carries a defining expression, which <Parameter> cannot author"
          : Object.keys(parameter.metadata).length > 0
            ? "the parameter carries metadata, which <Parameter> cannot author"
            : "the parameter's value is outside the canonical unit of its dimension",
      );
      state.declinedParameters.add(parameter.id);
    }
  }

  // 3. Bodies: display flags, sheet kind, and appearance are not authorable.
  for (const body of document.bodies) {
    if (
      body.kind !== undefined ||
      body.visible === false ||
      body.isolated === true ||
      body.appearance !== undefined ||
      body.faceAppearances !== undefined
    ) {
      decline(
        state,
        "body",
        body.id,
        "the body carries sheet/display/appearance state the element vocabulary cannot author",
      );
      state.declinedBodies.add(body.id);
    }
  }

  // 4. Sketches, then features.
  for (const sketch of document.sketches) {
    planSketch(state, sketch);
  }
  for (const feature of document.features) {
    planFeature(state, feature);
  }

  // 5. Decline cascades to a fixpoint: a feature consuming a declined
  //    feature declines, and a body a declined feature output declines.
  for (;;) {
    const before = state.declines.length;
    for (const feature of document.features) {
      if (state.declinedFeatures.has(feature.id)) continue;
      const brokenInput = feature.inputs.some(
        (input) =>
          input.kind === "feature" && state.declinedFeatures.has(input.id),
      );
      if (brokenInput) {
        declineFeature(
          state,
          feature.id,
          "the feature consumes a declined feature — its input graph cannot be reproduced",
        );
      }
    }
    for (const body of document.bodies) {
      if (state.declinedBodies.has(body.id)) continue;
      const producer = document.features.find(
        (feature) =>
          !state.declinedFeatures.has(feature.id) &&
          feature.outputs.some((output) => output === body.id),
      );
      const declinedProducer = document.features.some(
        (feature) =>
          state.declinedFeatures.has(feature.id) &&
          feature.outputs.some((output) => output === body.id),
      );
      if (producer === undefined && declinedProducer) {
        decline(
          state,
          "body",
          body.id,
          "the body's producing feature was declined — a standalone <Body> would not reproduce it",
        );
        state.declinedBodies.add(body.id);
      }
    }
    if (state.declines.length === before) break;
  }

  // 6. The DAG: consumer counts among surviving features, then the
  //    nesting choice. The FORMAT nests a feature consumed by exactly one
  //    later feature as that consumer's child — but nesting reorders the
  //    emission (children compile before parents), and the document's
  //    timeline order is the ground truth the model must reproduce. A
  //    document authored through `<Use>` references (single-consumed
  //    features standing alone) has them as top-level elements; the
  //    search below starts from maximal nesting and un-nests until the
  //    simulated feature order equals the timeline exactly.
  const consumersOf = new Map<string, number>();
  for (const feature of document.features) {
    if (state.declinedFeatures.has(feature.id)) continue;
    for (const input of feature.inputs) {
      if (input.kind !== "feature") continue;
      consumersOf.set(input.id, (consumersOf.get(input.id) ?? 0) + 1);
    }
  }
  const survivingFeatures = document.features.filter(
    (feature) => !state.declinedFeatures.has(feature.id),
  );
  const singleConsumed = new Set(
    survivingFeatures
      .filter((feature) => (consumersOf.get(feature.id) ?? 0) === 1)
      .map((feature) => feature.id),
  );
  const nestedIds = new Set<string>(singleConsumed);
  /** Assigns children for the current nesting choice. */
  const assignChildren = (): void => {
    for (const feature of survivingFeatures) {
      const element = state.elements.get(feature.id);
      if (element === undefined) continue;
      element.children = feature.inputs.flatMap((input): ChildPlan[] => {
        if (input.kind !== "feature") return [];
        if (nestedIds.has(input.id)) {
          const child = state.elements.get(input.id);
          if (child !== undefined) return [{ kind: "element", element: child }];
        }
        return [{ kind: "use", featureId: input.id }];
      });
    }
  };
  /** The feature order the current nesting emits (post-order walk). */
  const emittedFeatureOrder = (): string[] => {
    const order: string[] = [];
    const walk = (featureId: string): void => {
      const element = state.elements.get(featureId);
      if (element === undefined) return;
      for (const child of element.children) {
        if (child.kind === "element") walk(child.element.featureId);
      }
      order.push(featureId);
    };
    for (const feature of survivingFeatures) {
      if (nestedIds.has(feature.id)) continue;
      walk(feature.id);
    }
    return order;
  };
  assignChildren();
  for (;;) {
    const emitted = emittedFeatureOrder();
    const wanted = survivingFeatures.map((feature) => feature.id);
    const divergence = emitted.findIndex((id, index) => id !== wanted[index]);
    if (divergence === -1 && emitted.length === wanted.length) break;
    const emittedId = emitted[divergence];
    const wantedId = wanted[divergence];
    // Un-nest whichever side of the divergence is nested: an early-emitted
    // nested child or a wanted feature still trapped inside a parent.
    const toUnnest =
      emittedId !== undefined && nestedIds.has(emittedId)
        ? emittedId
        : wantedId !== undefined && nestedIds.has(wantedId)
          ? wantedId
          : null;
    if (toUnnest === null) break;
    nestedIds.delete(toUnnest);
    assignChildren();
  }
  const topLevelFeatures = survivingFeatures.filter(
    (feature) => !nestedIds.has(feature.id),
  );

  // 7. The canonical order, validated by simulating the exact per-kind
  //    command order the generated tree compiles to.
  const explicitParameters = document.parameters.parameters.filter(
    (parameter) =>
      !state.declinedParameters.has(parameter.id) &&
      !state.implicitParameterIds.has(parameter.id),
  );
  const survivingSketches = document.sketches.filter(
    (sketch) => !state.declinedSketches.has(sketch.id),
  );
  const survivingBodies = document.bodies.filter(
    (body) => !state.declinedBodies.has(body.id),
  );

  // Sketch placement: immediately before the first consuming feature's
  // top-level element; sketches no surviving feature consumes trail.
  const anchoredSketches = new Map<string, SketchPlan[]>();
  const trailingSketches: SketchPlan[] = [];
  for (const sketch of survivingSketches) {
    const plan = state.sketches.get(sketch.id);
    if (plan === undefined) continue;
    const firstConsumer = survivingFeatures.find((feature) =>
      feature.inputs.some(
        (input) => input.kind === "sketch" && input.id === sketch.id,
      ),
    );
    if (firstConsumer === undefined) {
      trailingSketches.push(plan);
      continue;
    }
    const anchor = topLevelFeatures.find(
      (feature) =>
        feature.id === firstConsumer.id ||
        subtreeContains(feature.id, firstConsumer.id, document),
    );
    const anchorId = anchor === undefined ? firstConsumer.id : anchor.id;
    const existing = anchoredSketches.get(anchorId) ?? [];
    existing.push(plan);
    anchoredSketches.set(anchorId, existing);
  }

  const simulated: { readonly kind: string; readonly id: string }[] = [];
  const push = (kind: string, id: string): void => {
    simulated.push({ kind, id });
  };
  const simulateElement = (element: ElementPlan): void => {
    if (element.bodyWrapper !== null) push("body", element.bodyWrapper.id);
    for (const child of element.children) {
      if (child.kind === "element") simulateElement(child.element);
    }
    for (const parameter of element.implicitParameters) {
      push("parameter", parameter.id);
    }
    const feature = document.features.find(
      (candidate) => candidate.id === element.featureId,
    );
    const outputBodyId = feature?.outputs[0];
    if (element.bodyWrapper === null && outputBodyId !== undefined) {
      push("body", outputBodyId);
    }
    push("feature", element.featureId);
  };
  for (const parameter of explicitParameters) push("parameter", parameter.id);
  for (const feature of topLevelFeatures) {
    const element = state.elements.get(feature.id);
    if (element === undefined) continue;
    for (const plan of anchoredSketches.get(feature.id) ?? []) {
      push("sketch", plan.sketchId);
    }
    simulateElement(element);
  }
  for (const plan of trailingSketches) push("sketch", plan.sketchId);
  // Bare bodies (no producing feature) close the model in body order.
  const bareBodies = survivingBodies.filter(
    (body) => !state.featureBodies.has(body.id),
  );
  for (const body of bareBodies) push("body", body.id);

  const expectOrder = (
    kind: string,
    expected: readonly { readonly id: string }[],
    code: GenerateTsxErrorCode,
  ): TsxGenerateError | null => {
    const actual = simulated.filter((entry) => entry.kind === kind);
    const mismatch =
      actual.length !== expected.length ||
      actual.some((entry, index) => entry.id !== expected[index]?.id);
    if (!mismatch) return null;
    const firstDiff = actual.findIndex(
      (entry, index) => entry.id !== expected[index]?.id,
    );
    return {
      code,
      input: null,
      message: `The document's ${kind} creation order cannot be reproduced by the canonical form (first divergence at position ${String(
        firstDiff === -1 ? expected.length : firstDiff,
      )}: the document declares "${expected[firstDiff]?.id ?? "(end)"}", the model emits "${actual[firstDiff]?.id ?? "(end)"}"); re-author the document with parameters first, sketches at their first consumer, and features in timeline order.`,
    };
  };
  const orderFailure =
    expectOrder(
      "parameter",
      document.parameters.parameters
        .filter((parameter) => !state.declinedParameters.has(parameter.id))
        .map((parameter) => ({ id: parameter.id })),
      GENERATE_TSX_ERROR_CODES.parameterOrder,
    ) ??
    expectOrder(
      "sketch",
      survivingSketches.map((sketch) => ({ id: sketch.id })),
      GENERATE_TSX_ERROR_CODES.sketchOrder,
    ) ??
    expectOrder(
      "feature",
      survivingFeatures.map((feature) => ({ id: feature.id })),
      GENERATE_TSX_ERROR_CODES.featureOrder,
    ) ??
    expectOrder(
      "body",
      survivingBodies.map((body) => ({ id: body.id })),
      GENERATE_TSX_ERROR_CODES.bodyOrder,
    );
  if (orderFailure !== null) return { ok: false, error: orderFailure };

  // 8. Render the source.
  const lines: string[] = [];
  lines.push("/**");
  lines.push(
    " * Generated by `generateTsx` from @slopcad/cad-jsx — the compiler's inverse.",
  );
  if (options.documentId !== undefined) {
    lines.push(` * Source document: ${options.documentId}.`);
  }
  lines.push(
    " * Compiled back through this package, the model reproduces the document",
  );
  lines.push(
    " * byte-stably (the document id and metadata belong to the emitting options).",
  );
  if (state.declines.length > 0) {
    lines.push(" *");
    lines.push(
      " * DECLINED RECORDS (present in the document, not representable in the",
    );
    lines.push(
      " * JSX vocabulary — this list is the whole ledger, nothing else was dropped):",
    );
    for (const note of state.declines) {
      lines.push(` *   - ${note.kind} ${note.id}: ${note.reason}`);
    }
  }
  lines.push(" */");

  const imports = new Set<string>();
  for (const parameter of explicitParameters) {
    imports.add("Parameter");
    if (parameter.value.dimension === "angle") imports.add("angle");
    if (parameter.value.dimension === "dimensionless") {
      imports.add("dimensionless");
    }
  }
  for (const plan of state.sketches.values()) {
    imports.add("Sketch");
    for (const entity of plan.entities) imports.add(entity.tag);
  }
  for (const element of state.elements.values()) {
    imports.add(element.tag);
    if (element.bodyWrapper !== null) imports.add("Body");
    for (const child of element.children) {
      if (child.kind === "use") imports.add("Use");
    }
  }
  if (bareBodies.length > 0) imports.add("Body");
  const importList = [...imports].sort();
  if (importList.length > 0) {
    lines.push(`import { ${importList.join(", ")} } from "@slopcad/cad-jsx";`);
    lines.push("");
  }
  lines.push("export default (");
  lines.push("  <>");
  for (const parameter of explicitParameters) {
    const magnitude = canonicalMagnitude(
      parameter.value,
      parameter.value.dimension as RoleDimension,
    );
    if (magnitude === null) continue;
    const expression =
      parameter.value.dimension === "angle"
        ? `angle(${renderNumber(magnitude)})`
        : parameter.value.dimension === "dimensionless"
          ? `dimensionless(${renderNumber(magnitude)})`
          : renderNumber(magnitude);
    lines.push(
      `    <Parameter id={${JSON.stringify(parameter.id)}} name={${JSON.stringify(parameter.name)}} value={${expression}} />`,
    );
  }
  for (const feature of topLevelFeatures) {
    const element = state.elements.get(feature.id);
    if (element === undefined) continue;
    for (const plan of anchoredSketches.get(feature.id) ?? []) {
      renderSketch(plan, 4, lines);
    }
    renderElement(element, 4, lines);
  }
  for (const plan of trailingSketches) renderSketch(plan, 4, lines);
  for (const body of bareBodies) {
    lines.push(
      `    <Body id={${JSON.stringify(body.id)}} name={${JSON.stringify(body.name)}} />`,
    );
  }
  lines.push("  </>");
  lines.push(");");
  lines.push("");

  return {
    ok: true,
    value: {
      declines: Object.freeze([...state.declines]),
      imports: Object.freeze(importList),
      source: lines.join("\n"),
    },
  };
}

/** True when `ancestorId`'s element subtree consumes `descendantId`. */
function subtreeContains(
  ancestorId: string,
  descendantId: string,
  document: CadDocument,
): boolean {
  const visited = new Set<string>();
  const stack = [ancestorId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current === descendantId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const feature = document.features.find(
      (candidate) => candidate.id === current,
    );
    if (feature === undefined) continue;
    for (const input of feature.inputs) {
      if (input.kind === "feature") stack.push(input.id);
    }
  }
  return false;
}
