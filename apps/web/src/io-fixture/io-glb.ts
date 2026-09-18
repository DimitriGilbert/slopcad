/**
 * GLB reference-viewer plumbing for the /io fixture (Phase 19): loads
 * exported GLB bytes with three's own GLTFLoader — the reference viewer the
 * plan's validation names, shipped inside the existing `three` dependency,
 * not a new one — and turns the LOADED scene back into the deterministic
 * render state the fixture's canvas draws.
 *
 * ## Honest provenance, in code
 *
 * Everything the viewer state carries is read OUT of the loaded scene: node
 * names, per-mesh vertex/triangle counts, the position/normal/index
 * buffers, and the parsed `pbrMetallicRoughness` material (a three
 * `MeshStandardMaterial` whose color three converts linear→sRGB for
 * `getHexString()`). The loaded buffers then flow through the public
 * `projectTessellation` boundary under the stable body id
 * `body_imported_glb`, exactly like every other imported mesh — the pixels
 * are rendered from the GLB's own decoded geometry, never from the source
 * soup that produced the bytes.
 */

import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshStandardMaterial } from "three";
import type {
  BufferAttribute,
  InterleavedBufferAttribute,
  Mesh,
  Object3D,
} from "three";
import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type ParseResult,
  type ProjectionError,
  type RenderProjection,
} from "@slopcad/cad-core";

import {
  fitCameraToBounds,
  meshBounds,
  meshSignedVolume,
  type MeshBounds,
} from "./io-mesh";

/** The GLB viewer body's stable id (distinct from the STL/3MF import id). */
const GLB_VIEWER_BODY_ID = createBodyId("body_imported_glb");

/** What one loaded mesh reports: its name and its decoded sizes. */
export interface GlbLoadedMesh {
  /** The GLTF node name the loader assigned (the exporter's node name). */
  readonly name: string;
  readonly vertices: number;
  readonly triangles: number;
}

/** The parsed material of the loaded scene, as machine-readable data. */
export interface GlbLoadedMaterial {
  /** The sRGB hex string of the loaded base color (e.g. `8aadf4`). */
  readonly colorHex: string;
  readonly metalness: number;
  readonly roughness: number;
}

/** What a successful GLB load leaves the fixture holding and rendering. */
export interface GlbViewerState {
  /** The loaded meshes, in scene-traversal order. */
  readonly meshes: readonly GlbLoadedMesh[];
  /** The first loaded mesh's parsed standard material, when present. */
  readonly material: GlbLoadedMaterial | null;
  /** The projection the deterministic canvas renders (loaded geometry). */
  readonly projection: RenderProjection;
  /** Total decoded triangle count across loaded meshes. */
  readonly triangles: number;
  /** The decoded soup's divergence-theorem volume in mm³. */
  readonly volume: number;
  /** The decoded soup's axis-aligned bounds in mm. */
  readonly bounds: MeshBounds;
}

function unwrapProjection(
  result: ParseResult<RenderProjection, ProjectionError>,
): RenderProjection {
  if (!result.ok) {
    throw new Error(`GLB viewer projection rejected: ${result.error.message}`);
  }
  return result.value;
}

/** Reads an xyz attribute into a flat number array via its accessors. */
function readAttribute(
  attribute: BufferAttribute | InterleavedBufferAttribute,
): number[] {
  const values: number[] = [];
  for (let i = 0; i < attribute.count; i += 1) {
    values.push(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
  }
  return values;
}

/**
 * Type predicate over three's documented runtime mesh flag (`isMesh` is
 * `true` on every `Mesh` and absent on plain `Object3D`/`Group` nodes).
 * Used instead of `instanceof Mesh` because narrowing a generic class from
 * its base type degrades to `Mesh<any, any, any>` and defeats the
 * typed-buffer guarantees below.
 */
function isMeshObject(object: Object3D): object is Mesh {
  return "isMesh" in object && object.isMesh === true;
}

/**
 * Loads `bytes` (a GLB asset) through three's GLTFLoader and derives the
 * deterministic viewer state from the LOADED scene: one render object per
 * loaded mesh under the `body_imported_glb` body id, the home-view fitted
 * camera, and the decoded soup's volume and bounds. Throws when the loader
 * rejects the bytes or when the scene carries no indexed mesh — a failed
 * round trip must be loud, never a blank viewport.
 */
export async function loadGlbViewerState(
  bytes: Uint8Array,
): Promise<GlbViewerState> {
  // parseAsync takes an ArrayBuffer; copy so the held bytes stay detached
  // from any larger buffer the loader might retain.
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  const gltf = await new GLTFLoader().parseAsync(buffer, "");
  const loaded: {
    name: string;
    positions: number[];
    indices: number[];
    normals?: number[];
    material: GlbLoadedMaterial | null;
  }[] = [];
  gltf.scene.traverse((child) => {
    if (!isMeshObject(child)) return;
    const positionAttribute: BufferAttribute | InterleavedBufferAttribute =
      child.geometry.getAttribute("position");
    if (positionAttribute === undefined) {
      throw new Error(`The loaded mesh "${child.name}" has no POSITION data.`);
    }
    const indexAttribute: BufferAttribute | InterleavedBufferAttribute | null =
      child.geometry.getIndex();
    if (indexAttribute === null) {
      throw new Error(
        `The loaded mesh "${child.name}" is not indexed; our exporter always writes indices.`,
      );
    }
    const indices: number[] = [];
    for (let i = 0; i < indexAttribute.count; i += 1) {
      indices.push(indexAttribute.getX(i));
    }
    const normalAttribute:
      BufferAttribute | InterleavedBufferAttribute | undefined =
      child.geometry.getAttribute("normal");
    const firstMaterial = Array.isArray(child.material)
      ? child.material[0]
      : child.material;
    loaded.push({
      name: child.name,
      positions: readAttribute(positionAttribute),
      indices,
      ...(normalAttribute === undefined
        ? {}
        : { normals: readAttribute(normalAttribute) }),
      material:
        firstMaterial instanceof MeshStandardMaterial
          ? {
              colorHex: firstMaterial.color.getHexString(),
              metalness: firstMaterial.metalness,
              roughness: firstMaterial.roughness,
            }
          : null,
    });
  });
  if (loaded.length === 0) {
    throw new Error("The loaded GLB scene contains no meshes.");
  }
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  let allHaveNormals = true;
  for (const mesh of loaded) {
    const base = positions.length / 3;
    positions.push(...mesh.positions);
    for (const index of mesh.indices) indices.push(base + index);
    if (mesh.normals === undefined) {
      allHaveNormals = false;
    } else {
      normals.push(...mesh.normals);
    }
  }
  const tessellation = allHaveNormals
    ? { positions, indices, normals }
    : { positions, indices };
  const object = projectTessellation(GLB_VIEWER_BODY_ID, tessellation);
  if (!object.ok) {
    throw new Error(
      `GLB viewer rejected the loaded soup: ${object.error.message}`,
    );
  }
  const projection = unwrapProjection(
    createRenderProjection(
      [object.value],
      fitCameraToBounds(meshBounds(tessellation)),
    ),
  );
  return {
    meshes: loaded.map((mesh) => ({
      name: mesh.name,
      vertices: mesh.positions.length / 3,
      triangles: mesh.indices.length / 3,
    })),
    material: loaded[0]?.material ?? null,
    projection,
    triangles: indices.length / 3,
    volume: meshSignedVolume(tessellation),
    bounds: meshBounds(tessellation),
  };
}
