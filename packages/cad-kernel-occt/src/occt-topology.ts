/**
 * OCCT topology snapshots and the {@link TopologyView} implementation
 * (Phase 22): the persistent-topology side of the cad-core reference
 * resolution protocol. `./occt-kernel`'s `topologySnapshot` operation (the
 * handle-resolving wrapper) lives here as
 * {@link occtShapeTopology}; the document-level view — the object
 * `resolveDocumentReference` gates on — lives here as
 * {@link occtTopologyView}.
 *
 * ## What the identity experiments proved (committed as
 * `topology-identity.test.ts` — this module's design constraints)
 *
 * - `ReplicadShapeHasher.HashCode` (TShape + location, orientation ignored)
 *   is allocation-address-derived: EVERY rebuild — same feature graph, same
 *   process, same operation sequence — produces a disjoint hash set. The
 *   hash is a within-regeneration identity only; it is exactly what the
 *   reference model records as the opaque identity payload and never more.
 * - Exploration yields OCCURRENCES: every edge of a solid appears twice
 *   (once per adjacent face) with the SAME hash, and a compound can carry
 *   one TShape twice. Snapshots therefore collapse occurrences by identity
 *   payload — mirroring `IsSame` semantics — and the ordinal is the first
 *   exploration index. A payload still colliding inside one snapshot is a
 *   REAL ambiguity the resolver must report (`ambiguous`), never guess.
 * - Face areas and centroids are bitwise-reproducible across rebuilds,
 *   centroids shift by exactly a rigid translation, and serialization
 *   preserves areas to ~1e-15 — so measures are reported RELATIVE to the
 *   solid's centre of mass (`BRepGProp.VolumeProperties` → `CentreOfMass`),
 *   the rigid-motion-invariant form the reference model's repair heuristic
 *   consumes.
 *
 * ## History-based names (Phase N1)
 *
 * Because the hash cannot survive a rebuild, a solid whose construction
 * named its faces (the solid store keeps {@link OcctFaceNames} beside the
 * shape) reports {@link OCCT_NAME_IDENTITY_SCHEMA} identities instead:
 * `data = { name }`, a deterministic string. Faces carry their construction
 * name (`<feature>/+X`, `<feature>/side/<segment>`, `<feature>/end`, …);
 * an edge's base name is the sorted multiset of the face names of its
 * face occurrences joined by `|` (a seam lists its face twice, a degenerate
 * pole edge once); a vertex's base name is the sorted SET of its adjacent
 * face names joined by `&`. Names never read a dimension, so identical
 * rebuilds and dimension edits reproduce them. Entities sharing a base name
 * are ordered by their body-relative geometry and suffixed `#<rank>`; a tie
 * no geometry separates keeps ONE shared name so the resolver reports
 * `ambiguous` rather than guessing. A solid without construction names (an
 * operation whose history is not yet tracked) reports the legacy
 * {@link OCCT_SHAPE_HASH_IDENTITY_SCHEMA} identity, still parseable: an old
 * hash reference resolves to `missing` against named snapshots, never a
 * crash.
 *
 * ## Names through topology-changing operations (Phase N2)
 *
 * One helper, {@link occtCarryFaceNames}, carries face names through a
 * builder's history for every operation that tracks it: for each named
 * input face `IsDeleted` drops the name, `Modified` keeps it (k images of a
 * split become `name#0 … name#(k−1)`, ordered by body-relative centroid,
 * then area), and faces the operation creates are named
 * `<feature>/<role>/<source name>` from `Generated(source)`. Every
 * multi-face history list — a split's `Modified` images, a created
 * source's `Generated` faces, a loft column's span walls, a moved face's
 * prism walls — takes its `#k` suffixes from that ONE geometric rule
 * ({@link occtNameHistoryFaces}), never from builder-list order. Edges and
 * vertices are re-derived from the carried face names exactly as in N1.
 * The operations, and what each names:
 *
 * - Fuse / Cut / Common (`union`, `subtract`, `intersect`, folded
 *   pairwise): both operands' names carried; the tool's surviving faces
 *   keep the names its OWN feature gave them; deleted faces are dropped.
 * - Transform (`BRepBuilderAPI_Transform`): every name preserved.
 * - MakeFillet (`fillet`): `<feature>/fillet/<edge name>` per blended
 *   edge, `<feature>/fillet/<vertex name>` per corner patch.
 * - MakeChamfer (`chamfer`): `<feature>/chamfer/<edge name>`, corner
 *   patches `<feature>/chamfer/<vertex name>`.
 * - MakeThickSolid (`shell`): kept faces keep their names, their offset
 *   walls are `<feature>/inner/<face name>`; a removed face's name is
 *   DROPPED (its references resolve `missing`), and the rim the engine
 *   reports as that face's trimmed `Modified` image is
 *   `<feature>/rim/<face name>`.
 *
 * Phase N2b — face ops, patterns and the remaining builders:
 *
 * - Transform as a pattern instance (`patternFeature`, `patternFace`,
 *   `patternPath`, the linear/polar patterns): the seed keeps its names,
 *   each placed copy is `<feature>/instance/<index>/<face name>` (the
 *   instance ordinal, stable across skips), then the fuse carries them.
 * - Transform as a reflection (`mirror`, both the direct and the oblique
 *   datum route): the copy is `<feature>/mirror/<face name>`.
 * - MakePrism + Fuse/Cut (`moveFace`, `replaceFace`'s parallel regime):
 *   the moved face keeps its name, the walls it sweeps are
 *   `<feature>/side/<edge name>`, its consumed start cap
 *   `<feature>/base/<face name>`.
 * - Covering-box Cut (`replaceFace`'s oblique regime): the plane's new face
 *   is `<feature>/plane/<face name>`; two surviving tool faces would share
 *   that name, so the result is then unnamed instead.
 * - Composite tool bodies: every bridge composition that builds a tool
 *   body names it under its OWN feature, so its faces never take the
 *   kernel's operation-default names (`extrude/…`, `revolve/…`) that two
 *   features would share. The Splitter-style covering cut (`split`) and
 *   the flat `hole`'s bore prism are `<feature>/tool/…`; the structured
 *   `hole`'s per-position revolve tools are `<feature>/tool/<i>/…` (its
 *   threaded ridge is the unnamed `helixSweep` below); the `rib`'s two
 *   half-extrudes are `<feature>/up/…` and `<feature>/down/…`. The
 *   subtract / union carries them.
 * - MakePipeShell (`sweep`): `<feature>/side/<segment key>` per profile
 *   edge, caps `<feature>/start` / `<feature>/end` (solid sweeps only).
 * - ThruSections (`loft`): span s's ruled wall from segment k is
 *   `<feature>/side/<s>/<key>`, caps `<feature>/start` / `<feature>/end`;
 *   a repartitioned (unequal-count) collection whose walls no section edge
 *   reports is unnamed.
 * - DraftAngle (tapered `extrude`): every face keeps its name (the engine
 *   reports drafted walls as `Generated` by their face, caps `Modified`).
 * - MakeThickSolid + Cut (`thicken`): the outer skin keeps its names, the
 *   cavity walls are `<feature>/inner/<face name>`.
 * - `deleteFace` declines structurally on this backend (no result, nothing
 *   to name).
 *
 * The operations that report no history over the faces they rebuild, and
 * whose output therefore stays UNNAMED (every one of them, by name):
 *
 * - Solid builders: `helixSweep` (the meridian-station helix sweep) and
 *   `sweepWire` (the attached-profile sweep).
 * - Sheet construction: `createSheet` (every surface kind).
 * - Sheet trimming: `trimSheet`, on BOTH routes — the Splitter route (the
 *   kept faces are re-sewn) and the Common / Cut route (`foldBoolean`
 *   without operand names); `untrimSheet`; `extendSheet`.
 * - Sheet stitching: `knit` (the sewn shell and the solid it closes into)
 *   and `unstitch` (the loose-face compound).
 * - Sheet surfacing: `fillPatch`, `offsetSheet`, and `thickenSheet` (the
 *   sheet-to-solid thickening; the solid `thicken` above is named).
 * - Sheet face ops: `replaceFaceWithSheet` and `deleteFaceKeepSurface`
 *   (both its remainder and its extracted face) — the sheet variants of
 *   the named `replaceFace` / the declining `deleteFace`.
 * - `section`: the cut solid it returns beside the section measure.
 *
 * An operation that cannot report history (the operations listed above as
 * unnamed, `importBrep` and `importStep`), an unnamed operand, or a result
 * face no history entry claims leaves the output UNNAMED: its snapshot reports
 * hash identities, and references into it fall back to cad-core's
 * `repairTopologyReference` — an explicit `repaired` state, refused when
 * geometric twins make it ambiguous.
 *
 * All measures use exact BREP integration (`UseTriangulation = false`), in
 * the kernel's canonical millimetres, and every embind wrapper is deleted
 * exactly once on the success path.
 */

import type {
  BodyId,
  ReferenceVector3,
  TopologyEntitySnapshot,
  TopologyIdentityPayload,
  TopologyReferenceKind,
  TopologySnapshot,
  TopologyView,
} from "@slopcad/cad-core";
import { topologyIdentityPayloadEqual } from "@slopcad/cad-core";
import type { KernelSolid } from "@slopcad/cad-kernel";
import type {
  NCollection_List_TopoDS_Shape,
  OpenCascadeInstance,
  TopAbs_ShapeEnum,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
} from "replicad-opencascadejs";
import type { OcctKernel } from "./occt-kernel";

import { OCCT_BACKEND_ID } from "./occt-backend";

/**
 * The history-based name schema (Phase N1): `data` carries `name` — the
 * deterministic construction name of the entity (see the module doc).
 * Survives identical rebuilds and dimension edits.
 */
export const OCCT_NAME_IDENTITY_SCHEMA = "occt-name/1";

/**
 * The legacy hash schema: `data` carries `hash` —
 * `ReplicadShapeHasher.HashCode(shape, upper)` of the entity's
 * `TopoDS_Shape` (TShape + location, orientation ignored). A
 * within-regeneration identity by the experiments' finding; reported only
 * by solids without construction names, and kept parseable for references
 * minted before names existed.
 */
export const OCCT_SHAPE_HASH_IDENTITY_SCHEMA = "occt-shape-hash-v1";

/** The primary identity schema this kernel mints: the name schema. */
export const OCCT_TOPOLOGY_IDENTITY_SCHEMA = OCCT_NAME_IDENTITY_SCHEMA;

/**
 * The upper bound handed to `ReplicadShapeHasher.HashCode`: hashes land in
 * `[1, 2^31 − 1]`, the widest signed-int range the binding accepts, keeping
 * accidental modulo collisions as rare as the kernel allows.
 */
export const OCCT_SHAPE_HASH_UPPER_BOUND = 2147483647;

/** The identity schemas this producer understands: names, then hashes. */
export const OCCT_TOPOLOGY_IDENTITY_SCHEMAS: readonly string[] = Object.freeze([
  OCCT_NAME_IDENTITY_SCHEMA,
  OCCT_SHAPE_HASH_IDENTITY_SCHEMA,
]);

/**
 * The construction names of a solid's faces, in the solid's collapsed
 * face-exploration order (the snapshot's face order): stored beside the
 * `TopoDS_Shape` in the kernel's solid store.
 */
export type OcctFaceNames = readonly string[];

/** One builder-history face and the construction name it carries. */
export interface OcctNamedFace {
  readonly face: TopoDS_Shape;
  readonly name: string;
}

/** The kinds a snapshot reports by default: faces, edges, and vertices. */
export const OCCT_TOPOLOGY_DEFAULT_KINDS: readonly TopologyReferenceKind[] =
  Object.freeze(["face", "edge", "vertex"]);

function hashOf(oc: OpenCascadeInstance, shape: TopoDS_Shape): number {
  return oc.ReplicadShapeHasher.HashCode(shape, OCCT_SHAPE_HASH_UPPER_BOUND);
}

function identityOf(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
): TopologyIdentityPayload {
  return Object.freeze({
    kernelId: OCCT_BACKEND_ID,
    schema: OCCT_SHAPE_HASH_IDENTITY_SCHEMA,
    data: Object.freeze({ hash: hashOf(oc, shape) }),
  });
}

/** The solid's centre of mass — the body-relative origin of all measures. */
function bodyCentroidOf(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
): {
  readonly x: number;
  readonly y: number;
  readonly z: number;
} {
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.VolumeProperties(shape, props, true, false, false);
    const com = props.CentreOfMass();
    try {
      return { x: com.X(), y: com.Y(), z: com.Z() };
    } finally {
      com.delete();
    }
  } finally {
    props.delete();
  }
}

/**
 * Explores one kind of sub-shape, measuring every occurrence and collapsing
 * repeats by identity payload: the ordinal is the first exploration index,
 * so a snapshot's ordinals are deterministic for one shape even where the
 * exploration itself repeats shared entities (every edge twice, a shared
 * TShape in a compound — both measured, see the module doc).
 */
function exploreKind(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  kind: TopologyReferenceKind,
  bodyCentroid: { readonly x: number; readonly y: number; readonly z: number },
): TopologyEntitySnapshot[] {
  const toFind =
    kind === "face"
      ? oc.TopAbs_ShapeEnum.TopAbs_FACE
      : kind === "edge"
        ? oc.TopAbs_ShapeEnum.TopAbs_EDGE
        : oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
  const entities: TopologyEntitySnapshot[] = [];
  const explorer = new oc.TopExp_Explorer(shape, toFind);
  try {
    let ordinal = 0;
    while (explorer.More()) {
      const current = explorer.Value();
      const identity = identityOf(oc, current);
      const duplicate = entities.some(
        (existing) =>
          existing.kind === kind &&
          existing.identity !== null &&
          topologyIdentityPayloadEqual(existing.identity, identity),
      );
      if (!duplicate) {
        entities.push(
          measureOf(oc, current, kind, ordinal, identity, bodyCentroid),
        );
      }
      ordinal += 1;
      explorer.Next();
    }
  } finally {
    explorer.delete();
  }
  return entities;
}

/**
 * Probes one face's surface geometry through `BRepAdaptor_Surface`: on
 * `GeomAbs_Cylinder` the exact `gp_Cylinder.Radius()` — the kernel's own
 * analytic radius, in canonical millimetres — is returned for the
 * descriptor's `cylinderRadiusMm` field (the Phase 27.3 radius measurement's
 * exact persistent path); any other surface type, or an adaptor that cannot
 * answer, reports `undefined` and the descriptor simply omits the field.
 * Every constructed wrapper is freed.
 */
function cylindricalRadiusOf(
  oc: OpenCascadeInstance,
  occurrence: TopoDS_Shape,
): number | undefined {
  const face = oc.TopoDS.Face(occurrence);
  const adaptor = new oc.BRepAdaptor_Surface(face, true);
  try {
    if (adaptor.GetType() !== oc.GeomAbs_SurfaceType.GeomAbs_Cylinder) {
      return undefined;
    }
    const cylinder = adaptor.Cylinder();
    try {
      const radius = cylinder.Radius();
      return Number.isFinite(radius) && radius > 0 ? radius : undefined;
    } finally {
      cylinder.delete();
    }
  } finally {
    adaptor.delete();
    face.delete();
  }
}

/** Measures one occurrence into an entity snapshot, exactly and freed. */
function measureOf(
  oc: OpenCascadeInstance,
  occurrence: TopoDS_Shape,
  kind: TopologyReferenceKind,
  ordinal: number,
  identity: TopologyIdentityPayload,
  bodyCentroid: { readonly x: number; readonly y: number; readonly z: number },
): TopologyEntitySnapshot {
  if (kind === "vertex") {
    const vertex = oc.TopoDS.Vertex(occurrence);
    try {
      const point = oc.BRep_Tool.Pnt(vertex);
      try {
        const absolute: ReferenceVector3 = Object.freeze([
          point.X(),
          point.Y(),
          point.Z(),
        ]);
        const relative: ReferenceVector3 = Object.freeze([
          point.X() - bodyCentroid.x,
          point.Y() - bodyCentroid.y,
          point.Z() - bodyCentroid.z,
        ]);
        return Object.freeze({
          kind,
          ordinal,
          identity,
          geometry: Object.freeze({
            pointAbsoluteMm: absolute,
            pointRelativeMm: relative,
          }),
        });
      } finally {
        point.delete();
      }
    } finally {
      vertex.delete();
    }
  }
  const props = new oc.GProp_GProps();
  try {
    if (kind === "face") {
      oc.BRepGProp.SurfaceProperties(occurrence, props, true, false);
    } else {
      oc.BRepGProp.LinearProperties(occurrence, props, true, false);
    }
    const com = props.CentreOfMass();
    try {
      const absolute: ReferenceVector3 = Object.freeze([
        com.X(),
        com.Y(),
        com.Z(),
      ]);
      const relative: ReferenceVector3 = Object.freeze([
        com.X() - bodyCentroid.x,
        com.Y() - bodyCentroid.y,
        com.Z() - bodyCentroid.z,
      ]);
      if (kind === "face") {
        // The surface-typing probe rides the face measure: a cylindrical
        // face carries its exact analytic radius alongside the summary
        // measures (see cylindricalRadiusOf).
        const cylinderRadiusMm = cylindricalRadiusOf(oc, occurrence);
        return Object.freeze({
          kind,
          ordinal,
          identity,
          geometry: Object.freeze({
            areaMm2: props.Mass(),
            centroidAbsoluteMm: absolute,
            centroidRelativeMm: relative,
            ...(cylinderRadiusMm === undefined ? {} : { cylinderRadiusMm }),
          }),
        });
      }
      return Object.freeze({
        kind,
        ordinal,
        identity,
        geometry: Object.freeze({
          lengthMm: props.Mass(),
          centroidAbsoluteMm: absolute,
          centroidRelativeMm: relative,
        }),
      });
    } finally {
      com.delete();
    }
  } finally {
    props.delete();
  }
}

/**
 * Produces the entity list of a snapshot for one OCCT shape: the requested
 * kinds, each occurrence-measured and identity-collapsed, in exploration
 * order. Every constructed wrapper is freed on the success path; a throw
 * inside the WASM boundary is the caller's no-throw boundary's concern.
 */
export function occtShapeTopology(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  kinds: readonly TopologyReferenceKind[] = OCCT_TOPOLOGY_DEFAULT_KINDS,
  faceNames: OcctFaceNames | null = null,
): readonly TopologyEntitySnapshot[] {
  const bodyCentroid = bodyCentroidOf(oc, shape);
  const entities: TopologyEntitySnapshot[] = [];
  for (const kind of kinds) {
    entities.push(...exploreKind(oc, shape, kind, bodyCentroid));
  }
  if (faceNames !== null) {
    const named = namedEntities(oc, shape, faceNames, entities, bodyCentroid);
    if (named !== null) return Object.freeze(named);
  }
  return Object.freeze(entities);
}

// ---------------------------------------------------------------------------
// History-based names (Phase N1)
// ---------------------------------------------------------------------------

/**
 * The distinct sub-shapes of one type in exploration order, collapsed by
 * hash exactly like {@link exploreKind}: the face order a
 * {@link OcctFaceNames} array indexes. The shapes are owned by the caller.
 */
export function occtDistinctSubShapes(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  toFind: TopAbs_ShapeEnum,
): TopoDS_Shape[] {
  const seen = new Set<number>();
  const found: TopoDS_Shape[] = [];
  const explorer = new oc.TopExp_Explorer(shape, toFind);
  try {
    while (explorer.More()) {
      const current = explorer.Value();
      const hash = hashOf(oc, current);
      if (seen.has(hash)) {
        current.delete();
      } else {
        seen.add(hash);
        found.push(current);
      }
      explorer.Next();
    }
  } finally {
    explorer.delete();
  }
  return found;
}

/**
 * Names every face of a freshly built shape by construction: `nameOf`
 * answers each collapsed face's name (from builder history or the
 * primitive's construction frame). One face the construction cannot name
 * leaves the whole solid unnamed (null) — a partial naming would mint names
 * for some entities and hashes for others in one snapshot.
 */
export function occtNameFaces(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  nameOf: (face: TopoDS_Shape) => string | null,
): OcctFaceNames | null {
  const faces = occtDistinctSubShapes(
    oc,
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
  );
  try {
    const names: string[] = [];
    for (const face of faces) {
      const name = nameOf(face);
      if (name === null) return null;
      names.push(name);
    }
    return Object.freeze(names);
  } finally {
    for (const face of faces) face.delete();
  }
}

/**
 * The `nameOf` of builder history, applied to the builder's own result
 * (before any placement): a result face is named by the history face it
 * `IsSame`s (same TShape AND location — a prism's two caps share one
 * TShape, so a partner test cannot tell them apart), unnamed when none
 * matches. The placement transform (`BRepBuilderAPI_Transform`, no copy)
 * only re-locates the shape, so the names keep their face order.
 */
export function occtHistoryFaceNamer(
  history: readonly OcctNamedFace[],
): (face: TopoDS_Shape) => string | null {
  return (face) => {
    const hit = history.find((entry) => entry.face.IsSame(face));
    return hit === undefined ? null : hit.name;
  };
}

/**
 * The shapes of one type in a builder-history list (`Generated`), owned by
 * the caller. The list is copied before being drained so the builder's own
 * list is never mutated; the caller still frees `list`.
 */
export function occtListShapes(
  oc: OpenCascadeInstance,
  list: NCollection_List_TopoDS_Shape,
  type: TopAbs_ShapeEnum,
): TopoDS_Shape[] {
  const copy = new oc.NCollection_List_TopoDS_Shape(list);
  const found: TopoDS_Shape[] = [];
  try {
    while (!copy.IsEmpty()) {
      const item = copy.First();
      copy.RemoveFirst();
      if (item.ShapeType() === type) found.push(item);
      else item.delete();
    }
  } finally {
    copy.delete();
  }
  return found;
}

/** The ordering key of one face: body-relative centroid, then area. */
function faceKeyOf(
  oc: OpenCascadeInstance,
  face: TopoDS_Shape,
  bodyCentroid: { readonly x: number; readonly y: number; readonly z: number },
): number[] {
  const props = new oc.GProp_GProps();
  try {
    oc.BRepGProp.SurfaceProperties(face, props, true, false);
    const com = props.CentreOfMass();
    try {
      return [
        com.X() - bodyCentroid.x,
        com.Y() - bodyCentroid.y,
        com.Z() - bodyCentroid.z,
        props.Mass(),
      ];
    } finally {
      com.delete();
    }
  } finally {
    props.delete();
  }
}

/**
 * Names the faces of one history list (the one suffix rule every history
 * reader shares, N1 constructors and N2 carries alike): a single face is
 * `name`; several are `name#0 … name#(k−1)`, ranked by their centroid
 * relative to `body`'s centre of mass, then area
 * ({@link occtRankDuplicateNames}: images no geometry separates share one
 * name — the resolver's `ambiguous`, never a guess).
 */
export function occtNameHistoryFaces(
  oc: OpenCascadeInstance,
  body: TopoDS_Shape,
  faces: readonly TopoDS_Shape[],
  name: string,
): OcctNamedFace[] {
  if (faces.length < 2) return faces.map((face) => ({ face, name }));
  const centroid = bodyCentroidOf(oc, body);
  const ranked = occtRankDuplicateNames(
    faces.map(() => name),
    faces.map((face) => faceKeyOf(oc, face, centroid)),
  );
  return faces.map((face, index) => ({ face, name: ranked[index] ?? name }));
}

/** Whether `shape` holds a sub-shape `IsSame` as `part`. */
export function occtContainsSame(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  part: TopoDS_Shape,
  type: TopAbs_ShapeEnum,
): boolean {
  const explorer = new oc.TopExp_Explorer(shape, type);
  try {
    while (explorer.More()) {
      const current = explorer.Value();
      const same = current.IsSame(part);
      current.delete();
      if (same) return true;
      explorer.Next();
    }
    return false;
  } finally {
    explorer.delete();
  }
}

/** Frees the history faces a builder-history reader collected. */
export function occtDisposeHistory(history: readonly OcctNamedFace[]): void {
  for (const entry of history) entry.face.delete();
}

// ---------------------------------------------------------------------------
// Names carried through topology-changing operations (Phase N2)
// ---------------------------------------------------------------------------

/**
 * The builder-history surface every topology-changing OCCT builder exposes
 * (`BRepBuilderAPI_MakeShape` and its subclasses: the booleans,
 * `BRepBuilderAPI_Transform`, `BRepFilletAPI_MakeFillet/MakeChamfer`,
 * `BRepOffsetAPI_MakeThickSolid`): embind classes satisfy it without casts.
 */
export interface OcctHistoryBuilder {
  Modified(shape: TopoDS_Shape): NCollection_List_TopoDS_Shape;
  Generated(shape: TopoDS_Shape): NCollection_List_TopoDS_Shape;
  IsDeleted(shape: TopoDS_Shape): boolean;
}

/** One operand of a history step: its shape and its face names (or none). */
export interface OcctNamedInput {
  readonly shape: TopoDS_Shape;
  readonly faceNames: OcctFaceNames | null;
}

/**
 * A source of faces the operation CREATES, and the name they carry
 * (`<feature>/<role>/<source name>`): read from the builder's `Generated`
 * list (a fillet's face from its edge, a shell's inner wall from its face)
 * or its `Modified` list (a shell's rim — the trimmed image of a removed
 * face whose own name the shell drops).
 */
export interface OcctCreatedSource {
  readonly source: TopoDS_Shape;
  readonly name: string;
  readonly history: "generated" | "modified";
}

/** Options of {@link occtCarryFaceNames}. */
export interface OcctCarryOptions {
  /** Faces created by the operation, named from their source. */
  readonly created?: readonly OcctCreatedSource[];
  /**
   * Input faces whose names the operation drops explicitly, like
   * `IsDeleted` faces (a shell's removed faces: the engine reports their
   * rim as `Modified`, the shell names it as a created face instead).
   */
  readonly dropped?: readonly TopoDS_Shape[];
}

/**
 * Carries face names through one builder step (Phase N2) — the one naming
 * helper every topology-changing operation shares. For each named input
 * face: `IsDeleted` (or listed in `dropped`) drops the name; an empty
 * `Modified` keeps the face itself under its name; one image keeps the
 * name; k images (a split) are `name#0 … name#(k−1)`, ranked by their
 * centroid relative to the RESULT's centre of mass, then area
 * ({@link occtNameHistoryFaces}). Every created source's
 * images take the source's name under the same split rule. A result face
 * no history entry claims, or an unnamed input, leaves the result unnamed
 * (null) — its snapshot reports hash identities and references into it
 * fall back to `repairTopologyReference`.
 */
export function occtCarryFaceNames(
  oc: OpenCascadeInstance,
  builder: OcctHistoryBuilder,
  result: TopoDS_Shape,
  inputs: readonly OcctNamedInput[],
  options: OcctCarryOptions = {},
): OcctFaceNames | null {
  const FACE = oc.TopAbs_ShapeEnum.TopAbs_FACE;
  if (inputs.some((input) => input.faceNames === null)) return null;
  const history: OcctNamedFace[] = [];
  const pushImages = (images: TopoDS_Shape[], name: string): void => {
    history.push(...occtNameHistoryFaces(oc, result, images, name));
  };
  try {
    for (const input of inputs) {
      const names = input.faceNames ?? [];
      const faces = occtDistinctSubShapes(oc, input.shape, FACE);
      const kept = new Set<TopoDS_Shape>();
      try {
        if (faces.length !== names.length) return null;
        faces.forEach((face, index) => {
          const name = names[index] ?? "";
          if (
            builder.IsDeleted(face) ||
            (options.dropped ?? []).some((dropped) => dropped.IsSame(face))
          ) {
            return;
          }
          const modified = builder.Modified(face);
          const images = occtListShapes(oc, modified, FACE);
          modified.delete();
          if (images.length === 0) {
            kept.add(face);
            history.push({ face, name });
          } else {
            pushImages(images, name);
          }
        });
      } finally {
        for (const face of faces) if (!kept.has(face)) face.delete();
      }
    }
    for (const created of options.created ?? []) {
      const list =
        created.history === "generated"
          ? builder.Generated(created.source)
          : builder.Modified(created.source);
      const images = occtListShapes(oc, list, FACE);
      list.delete();
      pushImages(images, created.name);
    }
    return occtNameFaces(oc, result, occtHistoryFaceNamer(history));
  } finally {
    occtDisposeHistory(history);
  }
}

/** One entity of a named shape and its snapshot name. */
export interface OcctNamedEntity {
  readonly shape: TopoDS_Shape;
  readonly name: string;
}

/**
 * The named entities of one kind on a named shape, in snapshot order: the
 * sources a feature names its created faces after (`<feature>/fillet/<edge
 * name>`). Null when the shape is unnamed (its snapshot carries hashes).
 * The returned shapes are caller-owned.
 */
export function occtNamedEntitiesOf(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  kind: TopologyReferenceKind,
  faceNames: OcctFaceNames | null,
): OcctNamedEntity[] | null {
  if (faceNames === null) return null;
  const entities = occtShapeTopology(oc, shape, [kind], faceNames);
  const names: string[] = [];
  for (const entity of entities) {
    const name = entity.identity?.data.name;
    if (
      entity.identity?.schema !== OCCT_NAME_IDENTITY_SCHEMA ||
      typeof name !== "string"
    ) {
      return null;
    }
    names.push(name);
  }
  const resolved = occtEntitiesAtOrdinals(
    oc,
    shape,
    kind,
    entities.map((entity) => entity.ordinal),
    (occurrence) => occurrence,
  );
  return resolved.occurrences.map((occurrence, index) => ({
    shape: occurrence,
    name: names[index] ?? "",
  }));
}

/** Body-relative point of a vertex, as a plain triple. */
function relativePointOf(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  bodyCentroid: { readonly x: number; readonly y: number; readonly z: number },
): readonly number[] {
  const vertex = oc.TopoDS.Vertex(shape);
  try {
    const point = oc.BRep_Tool.Pnt(vertex);
    try {
      return [
        point.X() - bodyCentroid.x,
        point.Y() - bodyCentroid.y,
        point.Z() - bodyCentroid.z,
      ];
    } finally {
      point.delete();
    }
  } finally {
    vertex.delete();
  }
}

/** Lexicographic tuple order: -1, 0, 1, comparing each pair within 1e-7. */
function compareKeys(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    const scale = Math.max(1, Math.abs(left), Math.abs(right));
    if (Math.abs(left - right) > 1e-7 * scale) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * Turns base names into unique names: a base carried by one entity stays
 * as is; a base carried by several ranks them by their body-relative
 * geometric key and suffixes `#<rank>`. Entities whose keys tie (no
 * geometry separates them) share one rank, hence one name — the resolver's
 * honest `ambiguous`, never a guess.
 */
export function occtRankDuplicateNames(
  bases: readonly string[],
  keys: readonly (readonly number[])[],
): string[] {
  const groups = new Map<string, number[]>();
  bases.forEach((base, index) => {
    const group = groups.get(base);
    if (group === undefined) groups.set(base, [index]);
    else group.push(index);
  });
  const names = [...bases];
  for (const [base, members] of groups) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((left, right) =>
      compareKeys(keys[left] ?? [], keys[right] ?? []),
    );
    let rank = 0;
    ordered.forEach((member, position) => {
      const previous = position === 0 ? undefined : ordered[position - 1];
      if (
        previous !== undefined &&
        compareKeys(keys[previous] ?? [], keys[member] ?? []) !== 0
      ) {
        rank = position;
      }
      names[member] = `${base}#${String(rank)}`;
    });
  }
  return names;
}

/** The geometric ordering key of one entity: its body-relative position. */
function geometricKeyOf(entity: TopologyEntitySnapshot): number[] {
  const geometry = entity.geometry;
  const position = geometry.centroidRelativeMm ??
    geometry.pointRelativeMm ?? [0, 0, 0];
  return [...position, geometry.areaMm2 ?? geometry.lengthMm ?? 0];
}

/**
 * Re-labels a hash-identified entity list with construction names: faces by
 * `faceNames`, edges by the sorted multiset of their face occurrences'
 * names, vertices by the sorted set of their adjacent face names, each
 * made unique by {@link occtRankDuplicateNames}. Null when `faceNames` does not fit
 * the shape (a face count mismatch) — the caller keeps the hash identities.
 */
function namedEntities(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  faceNames: OcctFaceNames,
  entities: readonly TopologyEntitySnapshot[],
  bodyCentroid: { readonly x: number; readonly y: number; readonly z: number },
): TopologyEntitySnapshot[] | null {
  const faces = occtDistinctSubShapes(
    oc,
    shape,
    oc.TopAbs_ShapeEnum.TopAbs_FACE,
  );
  const faceNameByHash = new Map<number, string>();
  const edgeFaces = new Map<number, string[]>();
  const vertexFaces = new Map<number, Set<string>>();
  try {
    if (faces.length !== faceNames.length) return null;
    faces.forEach((face, index) => {
      const name = faceNames[index] ?? "";
      faceNameByHash.set(hashOf(oc, face), name);
      const edges = new oc.TopExp_Explorer(
        face,
        oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      );
      try {
        while (edges.More()) {
          const edge = edges.Value();
          const hash = hashOf(oc, edge);
          edge.delete();
          const list = edgeFaces.get(hash);
          if (list === undefined) edgeFaces.set(hash, [name]);
          else list.push(name);
          edges.Next();
        }
      } finally {
        edges.delete();
      }
      const vertices = new oc.TopExp_Explorer(
        face,
        oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
      );
      try {
        while (vertices.More()) {
          const vertex = vertices.Value();
          const hash = hashOf(oc, vertex);
          vertex.delete();
          const set = vertexFaces.get(hash);
          if (set === undefined) vertexFaces.set(hash, new Set([name]));
          else set.add(name);
          vertices.Next();
        }
      } finally {
        vertices.delete();
      }
    });
  } finally {
    for (const face of faces) face.delete();
  }
  // An edge's key appends its sorted body-relative end points to its
  // centroid and length, so edges sharing faces AND a centroid (a sphere's
  // two poles) still order by geometry.
  const edgeEndpoints = new Map<number, number[]>();
  if (entities.some((entity) => entity.kind === "edge")) {
    const edges = occtDistinctSubShapes(
      oc,
      shape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    );
    try {
      for (const edge of edges) {
        const points = occtDistinctSubShapes(
          oc,
          edge,
          oc.TopAbs_ShapeEnum.TopAbs_VERTEX,
        );
        try {
          const relative = points
            .map((point) => relativePointOf(oc, point, bodyCentroid))
            .sort(compareKeys);
          edgeEndpoints.set(hashOf(oc, edge), relative.flat());
        } finally {
          for (const point of points) point.delete();
        }
      }
    } finally {
      for (const edge of edges) edge.delete();
    }
  }
  const bases: string[] = [];
  const keys: number[][] = [];
  for (const entity of entities) {
    const hash = entity.identity?.data.hash;
    if (typeof hash !== "number") return null;
    const base =
      entity.kind === "face"
        ? faceNameByHash.get(hash)
        : entity.kind === "edge"
          ? edgeFaces.get(hash)?.sort().join("|")
          : [...(vertexFaces.get(hash) ?? [])].sort().join("&");
    if (base === undefined || base === "") return null;
    // Kinds never collide: the base is kind-prefixed for grouping only.
    bases.push(`${entity.kind}:${base}`);
    const endpoints =
      entity.kind === "edge" ? (edgeEndpoints.get(hash) ?? []) : [];
    keys.push([...geometricKeyOf(entity), ...endpoints]);
  }
  const names = occtRankDuplicateNames(bases, keys);
  return entities.map((entity, index) =>
    Object.freeze({
      ...entity,
      identity: Object.freeze({
        kernelId: OCCT_BACKEND_ID,
        schema: OCCT_NAME_IDENTITY_SCHEMA,
        data: Object.freeze({
          name: (names[index] ?? "").slice(entity.kind.length + 1),
        }),
      }),
    }),
  );
}

/**
 * Resolves topology-snapshot ordinals to the shape's sub-shapes of one kind
 * (Phase 26.5 — the `fillet` operation's edge addressing, reused by the
 * Phase 26.6 `chamfer` and generalized to the Phase 26.7 `shell`'s FACE
 * addresses): the walk and the occurrence collapse are EXACTLY
 * `exploreKind`'s for the requested kind, so a `(kind, ordinal)` address a
 * snapshot reported names the same physical entity here — the guarantee
 * that makes snapshot ordinals safe kernel-side fillet/chamfer/shell
 * addresses. Returns the resolved occurrences in the requested order
 * (caller-owned: the caller deletes each after its last use, the module's
 * handle discipline) plus every requested ordinal the shape's collapsed
 * numbering does not carry — the stale-reference signature the kernel
 * surfaces as `kernel/fillet-edge-unknown` (the chamfer's and shell's own
 * kind-specific twins). A throw inside the WASM boundary is the caller's
 * no-throw boundary's concern, like the producer above.
 */
function occtEntitiesAtOrdinals<T extends TopoDS_Shape>(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  kind: TopologyReferenceKind,
  ordinals: readonly number[],
  cast: (occurrence: TopoDS_Shape) => T,
): {
  readonly occurrences: T[];
  readonly missing: readonly number[];
} {
  const toFind =
    kind === "face"
      ? oc.TopAbs_ShapeEnum.TopAbs_FACE
      : kind === "edge"
        ? oc.TopAbs_ShapeEnum.TopAbs_EDGE
        : oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
  const requested = new Set<number>(ordinals);
  const found = new Map<number, T>();
  /** Identity payload per collapsed ordinal, for occurrence deduplication. */
  const collapsed: TopologyIdentityPayload[] = [];
  const explorer = new oc.TopExp_Explorer(shape, toFind);
  try {
    let ordinal = 0;
    while (explorer.More()) {
      const current = explorer.Value();
      const identity = identityOf(oc, current);
      const duplicate = collapsed.some((existing) =>
        topologyIdentityPayloadEqual(existing, identity),
      );
      if (!duplicate) {
        if (requested.has(ordinal)) {
          found.set(ordinal, cast(current));
        }
        collapsed.push(identity);
      }
      ordinal += 1;
      explorer.Next();
    }
  } finally {
    explorer.delete();
  }
  const occurrences: T[] = [];
  const missing: number[] = [];
  for (const ordinal of ordinals) {
    const occurrence = found.get(ordinal);
    if (occurrence === undefined) {
      missing.push(ordinal);
      continue;
    }
    occurrences.push(occurrence);
  }
  return { occurrences, missing };
}

/**
 * Resolves topology-snapshot EDGE ordinals to the shape's `TopoDS_Edge`s
 * (Phase 26.5): the shared per-kind resolver over the `"edge"` kind,
 * returning typed edges for the fillet/chamfer builders. The returned
 * wrappers are caller-owned (each deleted after its last use); the
 * `missing` list is the stale-reference signature.
 */
export function occtEdgesAtOrdinals(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  ordinals: readonly number[],
): {
  readonly edges: TopoDS_Edge[];
  readonly missing: readonly number[];
} {
  const resolved = occtEntitiesAtOrdinals(
    oc,
    shape,
    "edge",
    ordinals,
    (occurrence) => oc.TopoDS.Edge(occurrence),
  );
  return { edges: resolved.occurrences, missing: resolved.missing };
}

/**
 * Resolves topology-snapshot FACE ordinals to the shape's `TopoDS_Face`s
 * (Phase 26.7 — the `shell` operation's face addressing): the shared
 * per-kind resolver over the `"face"` kind, the exact machinery
 * `occtEdgesAtOrdinals` runs for edges — an `(kind: "face", ordinal)`
 * address a snapshot reported names the same physical face here. The
 * returned wrappers are caller-owned (each deleted after its last use);
 * the `missing` list is the stale-reference signature the kernel surfaces
 * as `kernel/shell-face-unknown`.
 */
export function occtFacesAtOrdinals(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  ordinals: readonly number[],
): {
  readonly faces: TopoDS_Face[];
  readonly missing: readonly number[];
} {
  const resolved = occtEntitiesAtOrdinals(
    oc,
    shape,
    "face",
    ordinals,
    (occurrence) => oc.TopoDS.Face(occurrence),
  );
  return { faces: resolved.occurrences, missing: resolved.missing };
}

/** Options of {@link occtTopologyView}. */
export interface OcctTopologyViewOptions {
  /** The regeneration the view's snapshots report. */
  readonly regeneration: number;
  /**
   * The document bodies' current solids — the view's whole world: a body
   * absent from the map has no current regeneration result and reports a
   * null snapshot (the reference model's `missing`).
   */
  readonly bodies: ReadonlyMap<BodyId, KernelSolid>;
  /** The kinds to report; defaults to faces, edges, and vertices. */
  readonly kinds?: readonly TopologyReferenceKind[];
}

/**
 * The OCCT implementation of cad-core's {@link TopologyView}: the
 * persistent-topology resolver surface `resolveDocumentReference` gates on.
 * `snapshotOf` answers with the kernel's own `topologySnapshot` operation
 * for bodies the map carries; a kernel failure (a disposed handle — the
 * solid of an earlier regeneration) reports null, the honest "no current
 * topology for this body".
 */
export function occtTopologyView(
  kernel: OcctKernel,
  options: OcctTopologyViewOptions,
): TopologyView {
  return {
    kernelId: OCCT_BACKEND_ID,
    persistentTopology: true,
    identitySchemas: OCCT_TOPOLOGY_IDENTITY_SCHEMAS,
    snapshotOf(bodyId: BodyId): TopologySnapshot | null {
      const solid = options.bodies.get(bodyId);
      if (solid === undefined) return null;
      const snapshot = kernel.topologySnapshot(solid, {
        bodyId,
        regeneration: options.regeneration,
        ...(options.kinds !== undefined ? { kinds: options.kinds } : {}),
      });
      return snapshot.ok ? snapshot.value : null;
    },
  };
}
