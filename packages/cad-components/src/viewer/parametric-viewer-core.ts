/**
 * The parametric viewer's core (the final registry phase): the pure,
 * React-free half of the `parametric-cad-viewer` registry block —
 * everything the composition needs from a native document and a set of
 * tessellated bodies, built exclusively on the public cad-core and
 * cad-kernel surfaces, exactly like the package's parametric components.
 *
 * What lives here (each piece one pure function over public data):
 *
 * - {@link loadViewerSource} — parses native document text with the
 *   format's own full parser (`parseNativeCadDocumentFromString`: full
 *   transaction-log replay + state/log agreement — the same machinery a
 *   saved project or a shared link loads through, never a lenient second
 *   parser), hands back the live-session pair (document + history) a
 *   public `createCadStore` consumes, the chrome-facing summary, and the
 *   document-level state (metadata, rollback marker, regeneration states)
 *   re-serialization must preserve.
 * - {@link projectViewerBodies} — projects pre-tessellated bodies into the
 *   renderer-neutral {@link RenderProjection} the installed `CadViewport`
 *   draws, framing them with a deterministic home camera derived from the
 *   scene's own bounds unless the caller supplies one.
 * - {@link serializeViewerSession} — serializes the edited session back
 *   into the native format's canonical text, preserving the loaded
 *   document-level state byte-for-byte so a round trip loses nothing.
 *
 * ## The honest capability boundary
 *
 * This module renders and re-serializes; it does NOT evaluate geometry.
 * The native format's feature graph is host-interpreted (the workbench's
 * worker-backed engine), and no public package exposes that evaluation —
 * so the viewer takes the part's tessellation as INPUT (`ViewerBody[]`,
 * from whatever kernel the consumer drove), and re-derivation after a
 * parameter edit is the CONSUMER's side of the loop (the registry block's
 * `rebuild` contract). Nothing here fakes a re-drive: parameters are
 * committed through the real domain interpreter, and geometry changes only
 * when new tessellations arrive.
 */

import {
  parseNativeCadDocumentFromString,
  projectTessellation,
  createRenderProjection,
  stringifyNativeCadDocument,
  serializeNativeCadDocument,
  type BodyId,
  type CadDocument,
  type CadSession,
  type FeatureId,
  type FeatureRollbackPoint,
  type NativeCadDocument,
  type ParameterMetadataValue,
  type RegenerationStateMap,
  type RenderCamera,
  type RenderObject,
  type RenderProjection,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";

/** One rendered body of the part: its stable id and its tessellation. */
export interface ViewerBody {
  /** The body's stable document id (e.g. `body_plate`). */
  readonly bodyId: BodyId;
  /** The body's triangle soup, as any kernel's `tessellate` returns. */
  readonly tessellation: Tessellation;
  /** The producing feature's id, when the consumer knows it (provenance). */
  readonly featureId?: FeatureId;
}

/**
 * The document-level state that survives the file boundary and must ride
 * along when the edited session is re-serialized: the metadata (where the
 * display title lives), the rollback marker (a parked timeline reopens
 * parked), and the regeneration states.
 */
export interface ViewerPersistedState {
  readonly metadata: Readonly<Record<string, ParameterMetadataValue>>;
  readonly rollback: FeatureRollbackPoint | null;
  readonly regeneration: RegenerationStateMap;
}

/** The one-line facts the viewer chrome shows beside the part. */
export interface ViewerSourceSummary {
  /** The display title: the stored metadata title when set, else the id. */
  readonly title: string;
  /** The document's parameters (literal and expression-driven together). */
  readonly parameterCount: number;
  /** The document's feature records. */
  readonly featureCount: number;
  /** The document's body records. */
  readonly bodyCount: number;
}

/** The outcome of loading native text: the session pair, or why not. */
export type ViewerSourceLoad =
  | {
      readonly ok: true;
      /** The parsed session — exactly what `createCadStore` consumes. */
      readonly session: CadSession;
      /** The document at the history cursor. */
      readonly document: CadDocument;
      readonly summary: ViewerSourceSummary;
      readonly persisted: ViewerPersistedState;
    }
  | { readonly ok: false; readonly error: string };

/** The outcome of projecting tessellated bodies. */
export type ViewerProjectionBuild =
  | { readonly ok: true; readonly projection: RenderProjection }
  | { readonly ok: false; readonly error: string };

/** The home-view direction: eye in the (+x, −y, +z) octant, z-up (CAD). */
const HOME_VIEW_DIRECTION: readonly [number, number, number] = [1, -1.35, 1.4];
/** The eye distance as a multiple of the scene's bounding-sphere diagonal. */
const HOME_VIEW_DISTANCE_FACTOR = 1.7;
/** The vertical field of view of the derived home camera, in degrees. */
const HOME_VIEW_FOV_DEG = 40;
/** The three axis indices of a bounds triple, as a literal union. */
const AXES = [0, 1, 2] as const;

function vectorLength(vector: readonly [number, number, number]): number {
  return Math.sqrt(
    vector[0] * vector[0] + vector[1] * vector[1] + vector[2] * vector[2],
  );
}

/** The display title of a document: its metadata title when set, else the id. */
export function viewerTitleOf(
  document: CadDocument,
  metadata: Readonly<Record<string, ParameterMetadataValue>>,
): string {
  const title = metadata["title"];
  return typeof title === "string" && title.trim() !== "" ? title : document.id;
}

/**
 * Loads native document text: the full parser (base document + transaction
 * log replay + state/log agreement), the live-session pair, the chrome
 * summary, and the persisted state re-serialization preserves.
 */
export function loadViewerSource(nativeText: string): ViewerSourceLoad {
  const parsed = parseNativeCadDocumentFromString(nativeText);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error.message };
  }
  const native: NativeCadDocument = parsed.value;
  const document = native.document;
  return {
    ok: true,
    session: Object.freeze({
      document: native.document,
      history: native.history,
    }),
    document,
    summary: {
      title: viewerTitleOf(document, native.metadata),
      parameterCount: document.parameters.parameters.length,
      featureCount: document.features.length,
      bodyCount: document.bodies.length,
    },
    persisted: {
      metadata: native.metadata,
      rollback: native.rollback,
      regeneration: native.regeneration,
    },
  };
}

/**
 * Frames a deterministic home camera for a projected scene: the target is
 * the scene bounds' center, the eye sits in the (+x, −y, +z) octant at
 * ~1.7× the bounds diagonal (40° vertical FOV, z-up) — the same home-view
 * placement the workbench fixtures author by hand. Pure math over the
 * objects' own bounds; the same objects always frame identically. A
 * degenerate (zero-extent) scene falls back to a 1 mm span so the camera
 * stays valid.
 */
export function frameViewerCamera(
  objects: readonly RenderObject[],
): RenderCamera {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const object of objects) {
    for (const axis of AXES) {
      const objectMin = object.bounds.min[axis];
      const objectMax = object.bounds.max[axis];
      if (objectMin < min[axis]) min[axis] = objectMin;
      if (objectMax > max[axis]) max[axis] = objectMax;
    }
  }
  const target: readonly [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const diagonal = vectorLength([
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ]);
  const distance = Math.max(diagonal, 1) * HOME_VIEW_DISTANCE_FACTOR;
  const directionLength = vectorLength(HOME_VIEW_DIRECTION);
  return {
    kind: "perspective",
    position: [
      target[0] + (HOME_VIEW_DIRECTION[0] / directionLength) * distance,
      target[1] + (HOME_VIEW_DIRECTION[1] / directionLength) * distance,
      target[2] + (HOME_VIEW_DIRECTION[2] / directionLength) * distance,
    ],
    target,
    up: [0, 0, 1],
    fovDeg: HOME_VIEW_FOV_DEG,
  };
}

/**
 * Projects pre-tessellated bodies into the render projection the installed
 * viewport draws: one render object per body (public
 * {@link projectTessellation} validation — flat triples, finite, indices
 * in range, normals paired and unit), then the scene assembly (public
 * {@link createRenderProjection}, which refuses duplicate body ids). The
 * camera is the caller's, or the deterministic home view
 * {@link frameViewerCamera} derives from the projected objects' own
 * bounds. An empty body list is refused: a viewer with no geometry is a
 * loading state (`bodies === null`), not an empty projection.
 */
export function projectViewerBodies(
  bodies: readonly ViewerBody[],
  camera?: RenderCamera,
): ViewerProjectionBuild {
  if (bodies.length === 0) {
    return {
      ok: false,
      error: "A viewer projection needs at least one tessellated body.",
    };
  }
  const objects: RenderObject[] = [];
  for (const body of bodies) {
    const object =
      body.featureId === undefined
        ? projectTessellation(body.bodyId, body.tessellation)
        : projectTessellation(body.bodyId, body.tessellation, body.featureId);
    if (!object.ok) {
      return { ok: false, error: object.error.message };
    }
    objects.push(object.value);
  }
  const scene = createRenderProjection(
    objects,
    camera ?? frameViewerCamera(objects),
  );
  if (!scene.ok) {
    return { ok: false, error: scene.error.message };
  }
  return { ok: true, projection: scene.value };
}

/**
 * Serializes the edited session back into the native format's canonical
 * text — the same fixed-key-order, sorted-metadata serialization a save
 * writes — preserving the loaded document-level state
 * ({@link ViewerPersistedState}) so a round trip loses nothing: the same
 * document re-loads with its title, rollback marker, and regeneration
 * states intact.
 */
export function serializeViewerSession(
  session: CadSession,
  persisted: ViewerPersistedState,
): string {
  return stringifyNativeCadDocument(
    serializeNativeCadDocument({
      document: session.document,
      history: session.history,
      regeneration: persisted.regeneration,
      metadata: persisted.metadata,
      rollback: persisted.rollback,
      drawing: null,
    }),
  );
}
