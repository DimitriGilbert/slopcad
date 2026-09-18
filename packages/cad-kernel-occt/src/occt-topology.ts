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
  OpenCascadeInstance,
  TopoDS_Edge,
  TopoDS_Face,
  TopoDS_Shape,
} from "replicad-opencascadejs";
import type { OcctKernel } from "./occt-kernel";

import { OCCT_BACKEND_ID } from "./occt-backend";

/**
 * The identity schema of this kernel's snapshots: `data` carries
 * `hash` — `ReplicadShapeHasher.HashCode(shape, upper)` of the entity's
 * `TopoDS_Shape` (TShape + location, orientation ignored). A
 * within-regeneration identity by the experiments' finding; see the module
 * doc.
 */
export const OCCT_TOPOLOGY_IDENTITY_SCHEMA = "occt-shape-hash-v1";

/**
 * The upper bound handed to `ReplicadShapeHasher.HashCode`: hashes land in
 * `[1, 2^31 − 1]`, the widest signed-int range the binding accepts, keeping
 * accidental modulo collisions as rare as the kernel allows.
 */
export const OCCT_SHAPE_HASH_UPPER_BOUND = 2147483647;

/** The identity schemas this producer understands (one: its own). */
export const OCCT_TOPOLOGY_IDENTITY_SCHEMAS: readonly string[] = Object.freeze([
  OCCT_TOPOLOGY_IDENTITY_SCHEMA,
]);

/** The kinds a snapshot reports by default: faces, edges, and vertices. */
export const OCCT_TOPOLOGY_DEFAULT_KINDS: readonly TopologyReferenceKind[] =
  Object.freeze(["face", "edge", "vertex"]);

function identityOf(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
): TopologyIdentityPayload {
  return Object.freeze({
    kernelId: OCCT_BACKEND_ID,
    schema: OCCT_TOPOLOGY_IDENTITY_SCHEMA,
    data: Object.freeze({
      hash: oc.ReplicadShapeHasher.HashCode(shape, OCCT_SHAPE_HASH_UPPER_BOUND),
    }),
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
): readonly TopologyEntitySnapshot[] {
  const bodyCentroid = bodyCentroidOf(oc, shape);
  const entities: TopologyEntitySnapshot[] = [];
  for (const kind of kinds) {
    entities.push(...exploreKind(oc, shape, kind, bodyCentroid));
  }
  return Object.freeze(entities);
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
