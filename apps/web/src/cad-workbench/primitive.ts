/**
 * The workbench's primitive wiring: the document readers for the four
 * bridge primitives — `box`, `sphere`, `cylinder`, `cone` — read into the
 * worker-scene requests the document pass executes through the kernel's
 * own `solid.createBox` / `createSphere` / `createCylinder` /
 * `createCone` operations.
 *
 * ## The canonical layout (the bridge's, not a new one)
 *
 * The readers consume exactly the input layout `@slopcad/cad-kernel`'s
 * core bridge interprets: exactly one output body and ONLY positional
 * length parameters —
 *
 * - `box` — width, depth, height;
 * - `sphere` — radius;
 * - `cylinder` — radius, height;
 * - `cone` — bottomRadius, topRadius, height.
 *
 * ## The domain (enforced BEFORE any scene exists)
 *
 * The kernel contract's own domain gates the request (the `./pattern`
 * precedent): box extents, sphere/cylinder radius, and cylinder/cone
 * height strictly positive; the cone's bottom radius strictly positive
 * and its top radius non-negative (0 is a sharp cone). An out-of-domain
 * feature is a refused feature — it emits no scene entry, so the document
 * scene never presents a successful verdict over geometry regeneration
 * rejects.
 *
 * Every primitive feature renders (an every-feature producer, the
 * extrude/revolve per-feature loop's precedent): primitives consume
 * nothing, so each one is its own lineage root.
 *
 * ## The authoring seam (the workbench's primitive verbs)
 *
 * {@link primitiveCreateCommands} plans the ONE atomic transaction a
 * primitive verb commits (or the structured refusal — the shared
 * `AuthoringPlan` of `./authoring-id`): the dimension parameters, the
 * output body, and the primitive feature in the bridge layout above. The
 * layout carries no placement — every kernel builds the primitive in its
 * own frame (the box from its min corner at the origin, the cylinder/cone
 * on +z from `z = 0`, the sphere centred at the origin). A non-zero
 * placement therefore rides the EXISTING move-body vocabulary: a
 * `translate` feature over the primitive with the move's authored layout
 * (x/y/z plus the identity world-Z rotation pair — the move reader's
 * `>= 4` gate), so the placed body renders through the moveBody scene and
 * the primitive body is absorbed beneath it.
 */

import {
  angle,
  createBodyId,
  createFeatureId,
  dimensionless,
  length,
} from "@slopcad/cad-core";
import type { CadCommand, CadDocument, FeatureRecord } from "@slopcad/cad-core";

import {
  authoringLabelOf,
  authoringParameterCommand,
  authoringParameterIdOf,
  authoringParameterNameOf,
  authoringRefusal,
  authoringSuffixOf,
  type AuthoringPlan,
  type AuthoringRefusal,
} from "./authoring-id";
import { magnitudeIn, parameterValueOf } from "./parameter-magnitude";

/** The worker-scene payload one primitive feature executes as. */
export interface PrimitiveSceneRequest {
  /** The primitive's kind and its in-domain dimensions. */
  readonly shape: PrimitiveShape;
  /** The primitive feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/** The primitive feature kinds, in the verbs' display order. */
export const PRIMITIVE_KINDS = ["box", "sphere", "cylinder", "cone"] as const;

/** One primitive feature kind. */
export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

/** Whether `value` names a primitive feature kind. */
export function isPrimitiveKind(value: string): value is PrimitiveKind {
  return (PRIMITIVE_KINDS as readonly string[]).includes(value);
}

/**
 * The bridge's positional parameter roles per kind (the `readLengths`
 * names, in order) — the ONE layout table: the readers take each kind's
 * parameter count from it, the authoring seam mints one parameter per
 * role, {@link PrimitiveShape} carries one `${role}Mm` dimension per role,
 * and the primitive form shows one `${role}Mm` field per role.
 */
const PRIMITIVE_ROLES = {
  box: ["width", "depth", "height"],
  sphere: ["radius"],
  cylinder: ["radius", "height"],
  cone: ["bottomRadius", "topRadius", "height"],
} as const satisfies Readonly<Record<PrimitiveKind, readonly string[]>>;

/** One primitive dimension role (`width`, `bottomRadius`, …). */
export type PrimitiveRole = (typeof PRIMITIVE_ROLES)[PrimitiveKind][number];

/** The dimension key one role carries in a shape (and a form): `${role}Mm`. */
export type PrimitiveDimensionKey = `${PrimitiveRole}Mm`;

/** The dimension key of one role. */
export function primitiveDimensionKeyOf(
  role: PrimitiveRole,
): PrimitiveDimensionKey {
  return `${role}Mm`;
}

/** One kind's roles, in the bridge's positional order. */
export function primitiveRolesOf(
  kind: PrimitiveKind,
): readonly PrimitiveRole[] {
  return PRIMITIVE_ROLES[kind];
}

/**
 * One primitive's resolved dimensions (canonical mm), tagged by kind: one
 * `${role}Mm` per {@link PRIMITIVE_ROLES} role of the kind.
 */
export type PrimitiveShape = {
  readonly [Kind in PrimitiveKind]: { readonly kind: Kind } & {
    readonly [
      Role in (typeof PRIMITIVE_ROLES)[Kind][number] as `${Role}Mm`
    ]: number;
  };
}[PrimitiveKind];

/**
 * Reads the feature's positional length parameters in canonical mm — the
 * bridge's `readLengths` layout: EVERY input a parameter, exactly `count`
 * of them, each length-typed and finite. `null` on any mismatch.
 */
function primitiveLengthsMm(
  document: CadDocument,
  feature: FeatureRecord,
  count: number,
): readonly number[] | null {
  if (feature.inputs.length !== count) return null;
  const values: number[] = [];
  for (const ref of feature.inputs) {
    if (ref.kind !== "parameter") return null;
    const mm = magnitudeIn(parameterValueOf(document, ref.id), "length", "mm");
    if (mm === null) return null;
    values.push(mm);
  }
  return values;
}

/**
 * Resolves the in-domain shape of one primitive from its dimensions in
 * the bridge's positional order ({@link PRIMITIVE_ROLES}), or `null`
 * (refused: a missing or out-of-domain dimension).
 */
export function primitiveShapeOf(
  kind: string,
  lengths: readonly (number | undefined)[],
): PrimitiveShape | null {
  const [first, second, third] = lengths;
  if (kind === "box") {
    if (first === undefined || second === undefined || third === undefined) {
      return null;
    }
    if (!(first > 0) || !(second > 0) || !(third > 0)) return null;
    return { kind: "box", widthMm: first, depthMm: second, heightMm: third };
  }
  if (kind === "sphere") {
    if (first === undefined || !(first > 0)) return null;
    return { kind: "sphere", radiusMm: first };
  }
  if (kind === "cylinder") {
    if (first === undefined || second === undefined) return null;
    if (!(first > 0) || !(second > 0)) return null;
    return { kind: "cylinder", radiusMm: first, heightMm: second };
  }
  if (kind === "cone") {
    if (first === undefined || second === undefined || third === undefined) {
      return null;
    }
    if (!(first > 0) || !(second >= 0) || !(third > 0)) return null;
    return {
      kind: "cone",
      bottomRadiusMm: first,
      topRadiusMm: second,
      heightMm: third,
    };
  }
  return null;
}

/**
 * Reads ONE primitive feature into its worker-scene request. `null` when
 * the feature is not a primitive, declares other than exactly one output,
 * breaks the bridge's parameter layout, or carries an out-of-domain
 * dimension — the refused feature renders nothing. The per-feature
 * extraction the document readers share
 * (`documentPrimitiveSceneRequests` here, the document-scene builder's
 * per-body loop in `./document-scene`).
 */
export function primitiveSceneRequestOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): PrimitiveSceneRequest | null {
  const bodyId = feature.outputs[0];
  if (!isPrimitiveKind(feature.kind) || bodyId === undefined) return null;
  if (feature.outputs.length !== 1) return null;
  const count = primitiveRolesOf(feature.kind).length;
  const lengths = primitiveLengthsMm(document, feature, count);
  if (lengths === null) return null;
  const shape = primitiveShapeOf(feature.kind, lengths);
  return shape === null ? null : { shape, bodyId };
}

/**
 * Reads EVERY primitive feature of the document into its worker-scene
 * request, in document order. A feature whose layout or domain no longer
 * resolves is skipped honestly — the other primitives still render.
 */
export function documentPrimitiveSceneRequests(
  document: CadDocument,
): readonly PrimitiveSceneRequest[] {
  const requests: PrimitiveSceneRequest[] = [];
  for (const feature of document.features) {
    if (!isPrimitiveKind(feature.kind)) continue;
    const request = primitiveSceneRequestOfFeature(document, feature);
    if (request !== null) requests.push(request);
  }
  return requests;
}

/**
 * The primitive verb's authoring input: the shape's dimensions (canonical
 * mm, the {@link PrimitiveShape} vocabulary) and the placement offset the
 * primitive's kernel frame is translated by.
 */
export interface PrimitiveSubmission {
  readonly shape: PrimitiveShape;
  /** The placement offsets (mm); `[0, 0, 0]` keeps the kernel frame. */
  readonly offsetMm: readonly [number, number, number];
}

/** The forms' defaults per kind: a 20 mm part at the kernel frame. */
export const PRIMITIVE_DEFAULTS: Readonly<
  Record<PrimitiveKind, PrimitiveShape>
> = {
  box: { kind: "box", widthMm: 20, depthMm: 20, heightMm: 20 },
  sphere: { kind: "sphere", radiusMm: 10 },
  cylinder: { kind: "cylinder", radiusMm: 10, heightMm: 20 },
  cone: { kind: "cone", bottomRadiusMm: 10, topRadiusMm: 0, heightMm: 20 },
};

/** One dimension of a shape: its role and its value (mm). */
interface PrimitiveDimension {
  readonly role: PrimitiveRole;
  readonly mm: number;
}

/**
 * The shape's dimensions in the bridge's positional order, read through
 * {@link PRIMITIVE_ROLES} (`${role}Mm` per role) — `null` when one is
 * missing or not finite, so no dimension is ever defaulted.
 */
function primitiveDimensionsOf(
  shape: PrimitiveShape,
): readonly PrimitiveDimension[] | null {
  const values: Readonly<Partial<Record<PrimitiveDimensionKey, number>>> =
    shape;
  const dimensions: PrimitiveDimension[] = [];
  for (const role of primitiveRolesOf(shape.kind)) {
    const mm = values[primitiveDimensionKeyOf(role)];
    if (mm === undefined || !Number.isFinite(mm)) return null;
    dimensions.push({ role, mm });
  }
  return dimensions;
}

/**
 * Refuses the impossible primitive submissions BEFORE any commit — the
 * reader's own domain ({@link primitiveShapeOf}), so a committed primitive
 * always renders: positive box extents, sphere/cylinder radius, and
 * cylinder/cone height; a positive cone bottom radius and a non-negative
 * top radius; finite placement offsets. The in-domain arm carries the
 * dimensions the transaction mints.
 */
function primitiveDimensionsOrRefusal(
  submission: PrimitiveSubmission,
): readonly PrimitiveDimension[] | AuthoringRefusal {
  const { kind } = submission.shape;
  const dimensions = primitiveDimensionsOf(submission.shape);
  if (
    dimensions === null ||
    primitiveShapeOf(
      kind,
      dimensions.map((dimension) => dimension.mm),
    ) === null
  ) {
    return authoringRefusal(
      "kernel/parameter-invalid",
      kind === "cone"
        ? "A cone needs a positive bottom radius, a non-negative top radius (0 is a sharp cone), and a positive height (mm)."
        : `A ${kind}'s dimensions must be finite and strictly positive (mm).`,
    );
  }
  if (!submission.offsetMm.every((value) => Number.isFinite(value))) {
    return authoringRefusal(
      "kernel/parameter-invalid",
      "The placement offsets must be finite numbers (mm).",
    );
  }
  return dimensions;
}

/** The placement parameter roles (the move-body layout, in order). */
const PLACEMENT_ROLES = [
  "placeX",
  "placeY",
  "placeZ",
  "placeAxis",
  "placeAngle",
] as const;

/**
 * The first free suffix for a primitive: its feature and body, the
 * placement feature and body, and every dimension and placement
 * parameter (id and name) the transaction mints.
 */
function primitiveSuffixOf(document: CadDocument, kind: PrimitiveKind): string {
  const roles = [...primitiveRolesOf(kind), ...PLACEMENT_ROLES];
  return authoringSuffixOf(document, (suffix) => [
    `feat_${kind}${suffix}`,
    `feat_${kind}_place${suffix}`,
    `body_${kind}${suffix}`,
    `body_${kind}_placed${suffix}`,
    ...roles.flatMap((role) => [
      authoringParameterIdOf(kind, role, suffix),
      authoringParameterNameOf(kind, role, suffix),
    ]),
  ]);
}

/**
 * The primitive plan: the shared ok/refusal plan, the ok arm also saying
 * whether it carries the placement translate (the body then renders as
 * the moveBody scene; `bodyId` is the placed body).
 */
export type PrimitivePlan = AuthoringPlan<{ readonly placed: boolean }>;

/**
 * Plans the primitive verb's ONE atomic transaction: the dimension
 * parameters (named `<kind><Role>` — `boxWidth`, `coneTopRadius` — so
 * the parameter panel re-drives them), the output body, and the
 * primitive feature in the bridge layout; then, for a non-zero
 * placement, the placement parameters and the `translate` feature in the
 * move-body layout (see the module doc). The reader's domain is enforced
 * BEFORE the plan exists ({@link primitiveDimensionsOrRefusal}), so a committed
 * primitive always renders.
 */
export function primitiveCreateCommands(
  document: CadDocument,
  submission: PrimitiveSubmission,
): PrimitivePlan {
  const inDomain = primitiveDimensionsOrRefusal(submission);
  if ("ok" in inDomain) return inDomain;
  const kind = submission.shape.kind;
  const suffix = primitiveSuffixOf(document, kind);
  const label = authoringLabelOf(kind, suffix);
  const dimensions = inDomain.map(({ role, mm }) =>
    authoringParameterCommand(kind, role, suffix, length(mm)),
  );
  const bodyId = createBodyId(`body_${kind}${suffix}`);
  const featureId = createFeatureId(`feat_${kind}${suffix}`);
  const commands: CadCommand[] = [
    ...dimensions.map((parameter) => parameter.command),
    { type: "body.create", id: bodyId, name: label },
    {
      type: "feature.create",
      id: featureId,
      kind,
      inputs: dimensions.map((parameter) => ({
        kind: "parameter" as const,
        id: parameter.id,
      })),
      outputs: [bodyId],
    },
  ];
  const [x, y, z] = submission.offsetMm;
  if (x === 0 && y === 0 && z === 0) {
    return { ok: true, commands, bodyId, placed: false };
  }
  const placement = [
    authoringParameterCommand(kind, "placeX", suffix, length(x)),
    authoringParameterCommand(kind, "placeY", suffix, length(y)),
    authoringParameterCommand(kind, "placeZ", suffix, length(z)),
    // The identity rotation pair (world Z, 0 rad): the move layout's
    // authored pair, which the move reader's gate requires.
    authoringParameterCommand(kind, "placeAxis", suffix, dimensionless(3)),
    authoringParameterCommand(kind, "placeAngle", suffix, angle(0)),
  ];
  const placedBodyId = createBodyId(`body_${kind}_placed${suffix}`);
  commands.push(
    ...placement.map((parameter) => parameter.command),
    { type: "body.create", id: placedBodyId, name: `${label} placed` },
    {
      type: "feature.create",
      id: createFeatureId(`feat_${kind}_place${suffix}`),
      kind: "translate",
      inputs: [
        { kind: "feature", id: featureId },
        ...placement.map((parameter) => ({
          kind: "parameter" as const,
          id: parameter.id,
        })),
      ],
      outputs: [placedBodyId],
    },
  );
  return { ok: true, commands, bodyId: placedBodyId, placed: true };
}
