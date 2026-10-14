/**
 * The agent-facing feature-authoring vocabulary: the feature kinds the
 * document scene renders from their CANONICAL input layouts (the layouts
 * `@slopcad/cad-kernel`'s core bridge reads — `runKernelOperation`'s
 * primitive arms, `runEdgeCutOperation`, `runLocalFaceOperation`,
 * `runPatternFaceOperation` — and the workbench readers in
 * `../cad-workbench/primitive`, `./topology-cut`, `./face-op`, and
 * `./pattern` enforce). `cad_list_commands` serves it as data and
 * `cad_skill` renders it as a table, so the two can never disagree. The
 * list `cad_list_commands` serves is `featureVocabulary` (the summary's
 * `featureKinds` stays "the kinds in the timeline").
 *
 * Every entry authors through ONE `feature.create` command (via
 * `cad_apply_commands`): `inputs` lists the input refs in declared order,
 * `outputs` is exactly one NEW body id (distinct from any target's body).
 */

/** One input slot of a canonical feature layout. */
export interface FeatureInputSlot {
  /** The input ref kind the slot takes (`{ kind, id }` in `inputs`). */
  readonly kind: "parameter" | "feature" | "body" | "reference" | "datum";
  /** What the slot means to the operation. */
  readonly role: string;
  /** How many refs the slot takes: exactly one, or one or more. */
  readonly count: "1" | "1+";
  /** The parameter dimension (parameter slots only). */
  readonly dimension?: "length" | "angle" | "dimensionless";
  /** The slot's domain, as the reader enforces it before any scene exists. */
  readonly domain?: string;
}

/** One authorable feature kind and its canonical layout. */
export interface FeatureKindEntry {
  /** The `feature.create` `kind` field. */
  readonly kind: string;
  /** The family the kind belongs to. */
  readonly family: "primitive" | "topologyCut" | "faceOp" | "facePattern";
  /** The input slots, in declared order. */
  readonly inputs: readonly FeatureInputSlot[];
  /** The kernel capability the operation needs (`null`: every kernel). */
  readonly capability: string | null;
  /** One-line semantics. */
  readonly summary: string;
}

/** A positive LENGTH parameter slot. */
function positiveLength(role: string): FeatureInputSlot {
  return {
    count: "1",
    dimension: "length",
    domain: "> 0 mm",
    kind: "parameter",
    role,
  };
}

/** The single solid target slot (a producing feature id or a body id). */
const TARGET_SLOT: FeatureInputSlot = {
  count: "1",
  domain:
    "the producing feature id (or its body id); the feature's output must be a different body",
  kind: "feature",
  role: "target solid",
};

/** One FACE reference slot. */
const FACE_SLOT: FeatureInputSlot = {
  count: "1",
  domain: "a persistent FACE reference record on the target's own body",
  kind: "reference",
  role: "face",
};

/** One pattern-leg triple (direction, count, spacing). */
function legSlots(leg: string): readonly FeatureInputSlot[] {
  return [
    {
      count: "1",
      dimension: "angle",
      domain: "radians, counter-clockwise from the face plane's xAxis",
      kind: "parameter",
      role: `${leg} direction`,
    },
    {
      count: "1",
      dimension: "dimensionless",
      domain: "integer ≥ 2 (grid ≤ 1000 points)",
      kind: "parameter",
      role: `${leg} count`,
    },
    positiveLength(`${leg} spacing`),
  ];
}

/** The authorable kinds the document scene renders, with their layouts. */
export const FEATURE_KIND_VOCABULARY: readonly FeatureKindEntry[] = [
  {
    capability: null,
    family: "primitive",
    inputs: [
      positiveLength("width (X)"),
      positiveLength("depth (Y)"),
      positiveLength("height (Z)"),
    ],
    kind: "box",
    summary: "An axis-aligned box from its min corner at the origin.",
  },
  {
    capability: null,
    family: "primitive",
    inputs: [positiveLength("radius")],
    kind: "sphere",
    summary: "A sphere centred on the origin.",
  },
  {
    capability: null,
    family: "primitive",
    inputs: [positiveLength("radius"), positiveLength("height")],
    kind: "cylinder",
    summary: "A Z-axis cylinder standing on the origin.",
  },
  {
    capability: null,
    family: "primitive",
    inputs: [
      positiveLength("bottomRadius"),
      {
        count: "1",
        dimension: "length",
        domain: "≥ 0 mm (0 = pointed apex)",
        kind: "parameter",
        role: "topRadius",
      },
      positiveLength("height"),
    ],
    kind: "cone",
    summary: "A Z-axis cone or frustum standing on the origin.",
  },
  {
    capability: "fillet",
    family: "topologyCut",
    inputs: [
      TARGET_SLOT,
      {
        count: "1+",
        domain: "persistent EDGE reference records on the target's own body",
        kind: "reference",
        role: "edges",
      },
      positiveLength("radius"),
    ],
    kind: "fillet",
    summary: "Rounds the selected edges of the target.",
  },
  {
    capability: "chamfer",
    family: "topologyCut",
    inputs: [
      TARGET_SLOT,
      {
        count: "1+",
        domain: "persistent EDGE reference records on the target's own body",
        kind: "reference",
        role: "edges",
      },
      positiveLength("distance"),
    ],
    kind: "chamfer",
    summary: "Bevels the selected edges of the target (symmetric distance).",
  },
  {
    capability: "shell",
    family: "topologyCut",
    inputs: [
      TARGET_SLOT,
      {
        count: "1+",
        domain: "persistent FACE reference records on the target's own body",
        kind: "reference",
        role: "open faces",
      },
      positiveLength("wall thickness"),
    ],
    kind: "shell",
    summary: "Hollows the target, removing the selected faces.",
  },
  {
    capability: "localFaceOps",
    family: "faceOp",
    inputs: [
      TARGET_SLOT,
      FACE_SLOT,
      {
        count: "1",
        dimension: "dimensionless",
        domain: "1 = X, 2 = Y, 3 = Z",
        kind: "parameter",
        role: "axis",
      },
      {
        count: "1",
        dimension: "length",
        domain: "signed, finite mm",
        kind: "parameter",
        role: "distance",
      },
    ],
    kind: "moveFace",
    summary: "Moves one face along a world axis; neighbours follow.",
  },
  {
    capability: "localFaceOps",
    family: "faceOp",
    inputs: [
      TARGET_SLOT,
      FACE_SLOT,
      {
        count: "1",
        dimension: "dimensionless",
        domain: "1 = heal (extend neighbours), 0 = leave the gap open",
        kind: "parameter",
        role: "heal",
      },
    ],
    kind: "deleteFace",
    summary:
      "Removes one face; every current kernel (OCCT included) declines it, so the op renders its target in its place.",
  },
  {
    capability: "localFaceOps",
    family: "faceOp",
    inputs: [
      TARGET_SLOT,
      FACE_SLOT,
      {
        count: "1",
        domain: "a datum PLANE record (datum.create)",
        kind: "datum",
        role: "replacement plane",
      },
    ],
    kind: "replaceFace",
    summary: "Re-closes one face onto a datum plane.",
  },
  {
    capability: "persistentTopology",
    family: "facePattern",
    inputs: [
      { ...TARGET_SLOT, role: "solid to repeat" },
      { ...FACE_SLOT, role: "bounding planar face" },
      ...legSlots("leg 1"),
      ...legSlots("leg 2"),
    ],
    kind: "patternFace",
    summary:
      "Repeats the target over a two-leg grid in the face's plane, keeping the points inside the face.",
  },
];

/** One slot's compact table text: `kind role [dimension, domain]`. */
function slotText(slot: FeatureInputSlot): string {
  const detail = [slot.dimension, slot.domain].filter(
    (part): part is string => part !== undefined,
  );
  const count = slot.count === "1+" ? " (1 or more)" : "";
  return `${slot.kind} ${slot.role}${count}${detail.length === 0 ? "" : ` [${detail.join("; ")}]`}`;
}

/** The vocabulary as a markdown table (the skill guide's section body). */
export function featureVocabularyMarkdown(): string {
  const rows = FEATURE_KIND_VOCABULARY.map(
    (entry) =>
      `| ${entry.kind} | ${entry.inputs.map(slotText).join("; ")} | ${entry.capability ?? "any kernel"} | ${entry.summary} |`,
  );
  return [
    "| kind | inputs, in declared order | kernel capability | semantics |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}
