/**
 * The occupancy → hexahedral-element mesh mapping (Phase 69a, law S3's
 * consumer half — the `@slopcad/sim-thermal` `./grid` precedent): the
 * Phase 62 voxel grid is NODE-CENTERED, and the finite element this
 * solver owns is the DIRECT node interpretation — one uniform 8-node
 * hexahedron of size spacing × spacing × spacing CENTERED on each
 * occupied node. The documentation duty `sim-core`'s grid module names
 * ("the cell interpretation a solver derives from the node mask is the
 * consumer's documented mapping, never a second grid geometry") is
 * discharged here: no resampling, no second geometry, one conforming
 * mesh.
 *
 * ## The corner lattice (conformity)
 *
 * The element hosted at grid node (i, j, k) spans
 * [x_i − h/2, x_i + h/2] per axis, so two 6-adjacent occupied nodes
 * host elements that SHARE a face exactly, and a shared face carries
 * SHARED corner nodes — the mesh is conforming with no hanging nodes.
 * Corner positions live on the half-integer lattice: per axis the
 * corner of element i in direction dx ∈ {0, 1} sits at
 * `origin + (i + dx − ½)·h`, addressed by the even key
 * `hk = 2·(i + dx) ∈ {0, 2, …, 2·n}`. A corner key triple identifies
 * one finite-element node; numbering is FIRST-CONTACT in row-major
 * element order with corners in the fixed canonical order below —
 * deterministic (law S2): the same grid numbers the identical mesh
 * every time.
 *
 * ## Geometry honesty
 *
 * The meshed body spans `[origin − h/2, origin + (n − ½)·h]` per axis —
 * the physical body is exactly `n·h` long (node count × spacing), the
 * half-cell fringe the node-centered interpretation implies. Staircase
 * boundaries are the stated coarseness of every derived field (the S3
 * honesty; the convergence-band fixtures publish the deflection-vs-
 * resolution bands).
 */

// NOTE: no blank line between the type and value imports by force of
// eslint's import/order (the sim-thermal grid.ts precedent).
import {
  type SimError,
  type SimOccupancyGrid,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simGridGeometryProblem,
  simOk,
} from "@slopcad/sim-core";

/**
 * The canonical hex corner order — the bottom face counter-clockwise in
 * (x, y), then the top face — as per-axis direction bits (0 = the low
 * corner, 1 = the high corner). Every element loop in this package walks
 * corners in THIS order.
 */
export const HEX_CORNER_DIRECTIONS: readonly (readonly [
  0 | 1,
  0 | 1,
  0 | 1,
])[] = [
  [0, 0, 0],
  [1, 0, 0],
  [1, 1, 0],
  [0, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [1, 1, 1],
  [0, 1, 1],
] as const;

/**
 * The six-domain-face boundary mask bits a mesh node may carry: bit 0
 * xMin, 1 xMax, 2 yMin, 3 yMax, 4 zMin, 5 zMax. A node carries a face
 * bit exactly when its corner key sits on that face's extreme plane —
 * the face the fixture and load doors address.
 */
export const STRUCTURAL_FACE_BITS = {
  xMin: 1 << 0,
  xMax: 1 << 1,
  yMin: 1 << 2,
  yMax: 1 << 3,
  zMin: 1 << 4,
  zMax: 1 << 5,
} as const;

/** The conforming hexahedral mesh derived from an occupancy grid. */
export interface StructuralHexMesh {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly spacingM: readonly [number, number, number];
  readonly originM: readonly [number, number, number];
  /** The occupied node count — one element per occupied node. */
  readonly elementCount: number;
  /** The finite-element node count (the distinct corner-key triples). */
  readonly nodeCount: number;
  /** Flat grid index → element id (row-major first-contact), −1 on void. */
  readonly elementOfGridNode: Int32Array;
  /** Element id → its host grid node's flat index. */
  readonly gridNodeOfElement: Int32Array;
  /** Element id × 8 → its corner node ids (canonical order). */
  readonly elementNode: Uint32Array;
  /** Node id × 3 → the node position, m (the half-integer corner lattice). */
  readonly nodePositionM: Float64Array;
  /** Node id → its domain-face mask bits ({@link STRUCTURAL_FACE_BITS}). */
  readonly nodeFaceMask: Uint8Array;
}

/** The domain-face names the boundary doors address (the 61a vocabulary). */
const DOMAIN_FACES = ["xMin", "xMax", "yMin", "yMax", "zMin", "zMax"] as const;

export type StructuralDomainFace = (typeof DOMAIN_FACES)[number];

/** Whether an input is one of the six domain-face names. */
export function isStructuralDomainFace(
  input: unknown,
): input is StructuralDomainFace {
  return (
    typeof input === "string" &&
    (DOMAIN_FACES as readonly string[]).includes(input)
  );
}

/**
 * The node ids on one domain face of the mesh, ascending id order — the
 * deterministic node list the fixture and face-load doors distribute
 * over. A face with no nodes (the body does not reach that plane) is an
 * EMPTY list, which the load door declines loudly (a load that lands on
 * nothing is a lie), never a silent zero.
 */
export function structuralDomainFaceNodes(
  mesh: StructuralHexMesh,
  face: StructuralDomainFace,
): readonly number[] {
  const bit = STRUCTURAL_FACE_BITS[face];
  const nodes: number[] = [];
  for (let node = 0; node < mesh.nodeCount; node += 1) {
    if (((mesh.nodeFaceMask[node] ?? 0) & bit) !== 0) nodes.push(node);
  }
  return nodes;
}

/**
 * Builds the conforming hexahedral mesh from a Phase 62 occupancy grid:
 * one element per occupied node, corner nodes deduplicated by their
 * half-integer lattice keys, numbered first-contact in row-major
 * element order. Grid geometry problems decline through the grid
 * module's own door; a non-binary or count-mismatched mask declines
 * with the same `sim/grid-field-malformed` discipline; an all-void grid
 * declines here — zero elements bound no structure.
 */
export function structuralHexMesh(
  grid: SimOccupancyGrid,
): SimParseResult<StructuralHexMesh, SimError> {
  const geometryProblem = simGridGeometryProblem(grid);
  if (geometryProblem !== undefined) return simFail(geometryProblem);
  const nx = grid.shape[0] ?? 1;
  const ny = grid.shape[1] ?? 1;
  const nz = grid.shape[2] ?? 1;
  const cellCount = nx * ny * nz;
  if (grid.cells.length !== cellCount) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        `An occupancy grid's cell count (${String(grid.cells.length)}) must equal its extent product (${String(cellCount)}).`,
        grid.shape,
      ),
    );
  }
  for (const value of grid.cells) {
    if (value !== 0 && value !== 1) {
      return simFail(
        simError(
          SIM_ERROR_CODES.gridFieldMalformed,
          `An occupancy grid's cells must each be 0 or 1, received ${String(value)}.`,
          value,
        ),
      );
    }
  }

  const elementOfGridNode = new Int32Array(cellCount).fill(-1);
  const gridNodeOfElementList: number[] = [];
  const elementNodeList: number[] = [];
  const nodePositionList: number[] = [];
  const nodeFaceMaskList: number[] = [];
  // The corner-key map: packed (hkx, hky, hkz) → node id. Keys are exact
  // integers well inside double precision (≤ (2·n+1)³ ≤ 2^27 at the grid
  // budget).
  const nodeOfKey = new Map<number, number>();
  const keyStrideY = 2 * nx + 1;
  const keyStrideZ = keyStrideY * (2 * ny + 1);
  const [hx, hy, hz] = grid.spacingM;
  const [ox, oy, oz] = grid.originM;
  const half = [hx / 2, hy / 2, hz / 2] as const;

  let elementCount = 0;
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        const gridNode = i + j * nx + k * nx * ny;
        if (grid.cells[gridNode] !== 1) continue;
        const element = elementCount;
        elementCount += 1;
        elementOfGridNode[gridNode] = element;
        gridNodeOfElementList.push(gridNode);
        // Element center = the occupied node's own position.
        const center = [
          ox + i * (hx ?? 1),
          oy + j * (hy ?? 1),
          oz + k * (hz ?? 1),
        ] as const;
        for (const [dx, dy, dz] of HEX_CORNER_DIRECTIONS) {
          const hkx = 2 * (i + dx);
          const hky = 2 * (j + dy);
          const hkz = 2 * (k + dz);
          const key = hkx + hky * keyStrideY + hkz * keyStrideZ;
          let node = nodeOfKey.get(key);
          if (node === undefined) {
            node = nodePositionList.length / 3;
            nodeOfKey.set(key, node);
            nodePositionList.push(
              (center[0] ?? 0) + (dx === 1 ? 1 : -1) * (half[0] ?? 0),
              (center[1] ?? 0) + (dy === 1 ? 1 : -1) * (half[1] ?? 0),
              (center[2] ?? 0) + (dz === 1 ? 1 : -1) * (half[2] ?? 0),
            );
            let mask = 0;
            if (hkx === 0) mask |= STRUCTURAL_FACE_BITS.xMin;
            if (hkx === 2 * nx) mask |= STRUCTURAL_FACE_BITS.xMax;
            if (hky === 0) mask |= STRUCTURAL_FACE_BITS.yMin;
            if (hky === 2 * ny) mask |= STRUCTURAL_FACE_BITS.yMax;
            if (hkz === 0) mask |= STRUCTURAL_FACE_BITS.zMin;
            if (hkz === 2 * nz) mask |= STRUCTURAL_FACE_BITS.zMax;
            nodeFaceMaskList.push(mask);
          }
          elementNodeList.push(node);
        }
      }
    }
  }
  if (elementCount === 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.gridFieldMalformed,
        "The occupancy grid carries no solid nodes; zero hexahedra bound no structure, and the mesh door declines instead of fabricating an empty mesh.",
        grid.shape,
      ),
    );
  }
  return simOk(
    Object.freeze({
      nx,
      ny,
      nz,
      spacingM: grid.spacingM,
      originM: grid.originM,
      elementCount,
      nodeCount: nodePositionList.length / 3,
      elementOfGridNode,
      gridNodeOfElement: Int32Array.from(gridNodeOfElementList),
      elementNode: Uint32Array.from(elementNodeList),
      nodePositionM: Float64Array.from(nodePositionList),
      nodeFaceMask: Uint8Array.from(nodeFaceMaskList),
    }),
  );
}
