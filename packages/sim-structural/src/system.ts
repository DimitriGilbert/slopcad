/**
 * The assembly layer (Phase 69a, the `@slopcad/sim-thermal` `./system`
 * precedent): one call — {@link assembleStructuralSystem} — scatters the
 * per-material element stiffness matrices (`./element`) into a
 * compressed-sparse-row global matrix over the FREE degrees of freedom,
 * and accumulates the load vector (nodal loads from the resolved
 * boundary conditions, plus the body-force family: self-weight,
 * centrifugal, thermal initial strain). Fixtures are homogeneous
 * Dirichlet conditions — the fixed nodes' rows and columns simply leave
 * the reduced system, which is what keeps the reduced matrix symmetric
 * positive definite (every fixed dof is dropped, never penalty-softened).
 *
 * ## Determinism (law S2)
 *
 * Node and element numbering come from the mesh's first-contact
 * row-major discipline; each CSR row's column list is built node-major
 * then sorted ascending; the value scatter walks elements in id order
 * with corner pairs in the fixed canonical order — identical inputs
 * assemble the bitwise-identical matrix and load vector.
 *
 * ## Complexity (stated, not hidden)
 *
 * The stiffness stencil of a voxel-hex node couples it to the corner
 * nodes of the ≤ 8 elements it belongs to — up to 27 nodes, 81 dofs,
 * within one element's own 24×24 block; assembly is
 * O(elements · 576 · log S) and the matrix stores O(dofs · stencil)
 * nonzeros. The reference fixtures stay small-grid; the solver's cost
 * per iteration is one sparse matvec over those nonzeros.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { StructuralSolidMaterial } from "./material";
import type { StructuralHexMesh } from "./mesh";

import {
  hexDMatrix,
  hexStiffness,
  hexThermalLoad,
  hexUniformBodyLoad,
  hexCentrifugalLoad,
} from "./element";

/** The centrifugal stance: rotation about an axis at angular rate ω. */
export interface StructuralCentrifugalSpec {
  /** One point on the axis, m (solver space). */
  readonly axisPointM: readonly [number, number, number];
  /** The axis direction — normalized by the door that validates it. */
  readonly axisDirection: readonly [number, number, number];
  /** The angular rate ω, rad/s (the load is ω²-driven). */
  readonly omegaRadPerS: number;
}

/** One resolved nodal load: a force vector at a mesh node id. */
export interface StructuralNodalLoad {
  readonly node: number;
  readonly forceN: readonly [number, number, number];
}

/** What {@link assembleStructuralSystem} consumes — all solver space. */
export interface StructuralAssemblySpec {
  readonly mesh: StructuralHexMesh;
  /** The selected materials (solver space, the material door's output). */
  readonly materials: readonly StructuralSolidMaterial[];
  /** Per grid node → 1-based index into materials; 0 on void nodes. */
  readonly cellMaterialIndex: Uint16Array;
  /** The gravity vector, m/s² — self-weight's body force. */
  readonly gravityMPerS2: readonly [number, number, number];
  /** The centrifugal stance, when the scenario spins the body. */
  readonly centrifugal?: StructuralCentrifugalSpec;
  /** Per grid node temperature rise ΔT, K — the Phase 65 chaining seam. */
  readonly thermalDeltaTK?: Float64Array;
  /**
   * The fixture mask over all dofs (3 per node): 1 = that component is
   * homogeneously fixed (a full fixture sets all three; an axis fixture
   * — the symmetry/roller — sets one).
   */
  readonly fixedDofMask: Uint8Array;
  /** The resolved nodal loads (face/point/pressure, door-resolved). */
  readonly nodalLoads: readonly StructuralNodalLoad[];
}

/** The assembled reduced system the solver consumes. */
export interface AssembledStructuralSystem {
  readonly mesh: StructuralHexMesh;
  readonly nodeCount: number;
  readonly elementCount: number;
  /** Total dofs (3 per node). */
  readonly dofCount: number;
  /** Free dofs — the reduced system's dimension. */
  readonly freeDofCount: number;
  /** Fixed dofs (the fixture count × 3). */
  readonly fixedDofCount: number;
  /** dof id → free dof id, −1 when fixed. */
  readonly freeIndexOfDof: Int32Array;
  /** CSR row pointers, length freeDofCount + 1. */
  readonly rowPtr: Int32Array;
  /** CSR column indices (ascending within each row). */
  readonly colIndex: Int32Array;
  /** CSR values (symmetric, the full matrix stored). */
  readonly values: Float64Array;
  /** The reduced load vector, length freeDofCount. */
  readonly forceFree: Float64Array;
}

const refuse = (
  message: string,
  at: unknown,
): SimParseResult<never, SimError> =>
  simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));

/** Binary search for `col` inside the sorted CSR row `row`. */
function slotOf(
  rowPtr: Int32Array,
  colIndex: Int32Array,
  row: number,
  col: number,
): number {
  let low = rowPtr[row] ?? 0;
  let high = (rowPtr[row + 1] ?? 0) - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const value = colIndex[mid] ?? 0;
    if (value === col) return mid;
    if (value < col) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/**
 * Assembles the reduced system: material caching (one D and one Kₑ per
 * material — the grid is regular, equal-size elements share stiffness),
 * the body-force family over elements in id order, and the CSR scatter
 * described in the module doc. The spec's fixed-node list may be
 * empty — the SINGULAR posture the run door declines before solving,
 * kept reachable here so the assembly itself stays pure.
 */
export function assembleStructuralSystem(
  spec: StructuralAssemblySpec,
): SimParseResult<AssembledStructuralSystem, SimError> {
  const { mesh, materials } = spec;
  const cellCount = mesh.nx * mesh.ny * mesh.nz;
  if (spec.cellMaterialIndex.length !== cellCount) {
    return refuse(
      `The per-cell material index must cover exactly the grid's node count (${String(cellCount)}).`,
      spec.cellMaterialIndex.length,
    );
  }
  if (materials.length === 0) {
    return refuse(
      "A structural assembly needs at least one material.",
      materials.length,
    );
  }
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (mesh.elementOfGridNode[cell] === -1) continue;
    const index = spec.cellMaterialIndex[cell] ?? 0;
    if (index < 1 || index > materials.length) {
      return refuse(
        `A solid node's material index (${String(index)}) does not address one of the ${String(materials.length)} selected materials.`,
        index,
      );
    }
  }
  const thermalActive = spec.thermalDeltaTK !== undefined;
  if (thermalActive) {
    if (spec.thermalDeltaTK.length !== cellCount) {
      return refuse(
        `The per-cell temperature rise field must cover exactly the grid's node count (${String(cellCount)}).`,
        spec.thermalDeltaTK?.length,
      );
    }
    for (const value of spec.thermalDeltaTK) {
      if (!Number.isFinite(value)) {
        return refuse(
          "The per-cell temperature rise field must be finite everywhere.",
          value,
        );
      }
    }
  }

  // Per-material D and Kₑ (the grid is regular: one Kₑ per material).
  const dMatrices: Float64Array[] = [];
  const stiffnesses: Float64Array[] = [];
  for (const material of materials) {
    dMatrices.push(hexDMatrix(material.youngsModulusPa, material.poissonRatio));
    stiffnesses.push(
      hexStiffness(
        dMatrices[dMatrices.length - 1] as Float64Array,
        mesh.spacingM[0] ?? 1,
        mesh.spacingM[1] ?? 1,
        mesh.spacingM[2] ?? 1,
      ),
    );
  }

  const nodeCount = mesh.nodeCount;
  const dofCount = nodeCount * 3;

  // The fixture mask and the free-dof numbering (nodes in id order).
  if (spec.fixedDofMask.length !== dofCount) {
    return refuse(
      `The fixture mask must cover exactly the mesh's dof count (${String(dofCount)}).`,
      spec.fixedDofMask.length,
    );
  }
  const fixedDof = spec.fixedDofMask;
  const freeIndexOfDof = new Int32Array(dofCount).fill(-1);
  let freeDofCount = 0;
  for (let dof = 0; dof < dofCount; dof += 1) {
    if (fixedDof[dof] === 1) continue;
    freeIndexOfDof[dof] = freeDofCount;
    freeDofCount += 1;
  }

  // The node→element adjacency (CSR, element-id order).
  const nodeElementCount = new Int32Array(nodeCount);
  for (let corner = 0; corner < mesh.elementNode.length; corner += 1) {
    const counted = mesh.elementNode[corner] ?? 0;
    nodeElementCount[counted] = (nodeElementCount[counted] ?? 0) + 1;
  }
  const nodeElementPtr = new Int32Array(nodeCount + 1);
  for (let node = 0; node < nodeCount; node += 1) {
    nodeElementPtr[node + 1] =
      (nodeElementPtr[node] ?? 0) + (nodeElementCount[node] ?? 0);
  }
  const nodeElement = new Int32Array(mesh.elementNode.length);
  const nodeElementCursor = Int32Array.from(
    nodeElementPtr.subarray(0, nodeCount),
  );
  for (let element = 0; element < mesh.elementCount; element += 1) {
    for (let corner = 0; corner < 8; corner += 1) {
      const node = mesh.elementNode[element * 8 + corner] ?? 0;
      nodeElement[nodeElementCursor[node] ?? 0] = element;
      nodeElementCursor[node] = (nodeElementCursor[node] ?? 0) + 1;
    }
  }

  // The CSR structure: node-major rows, deduped by a row-epoch mark on
  // the candidate columns, sorted ascending. freeIndexOfDof assigns
  // free ids ascending in node-major dof order — the same order rows
  // are pushed here — so scratch index i IS row i.
  const colSeen = new Int32Array(freeDofCount).fill(-1);
  const rowScratch: number[][] = [];
  for (let node = 0; node < nodeCount; node += 1) {
    for (let component = 0; component < 3; component += 1) {
      const row = freeIndexOfDof[node * 3 + component] ?? -1;
      if (row === -1) continue;
      const cols: number[] = [];
      for (
        let slot = nodeElementPtr[node] ?? 0;
        slot < (nodeElementPtr[node + 1] ?? 0);
        slot += 1
      ) {
        const element = nodeElement[slot] ?? 0;
        for (let corner = 0; corner < 8; corner += 1) {
          const neighbour = mesh.elementNode[element * 8 + corner] ?? 0;
          for (let other = 0; other < 3; other += 1) {
            const col = freeIndexOfDof[neighbour * 3 + other] ?? -1;
            if (col === -1) continue;
            if ((colSeen[col] ?? -1) !== row) {
              colSeen[col] = row;
              cols.push(col);
            }
          }
        }
      }
      cols.sort((a, b) => a - b);
      rowScratch.push(cols);
    }
  }
  const rowPtr = new Int32Array(freeDofCount + 1);
  let stored = 0;
  for (let row = 0; row < freeDofCount; row += 1) {
    rowPtr[row] = stored;
    stored += rowScratch[row]?.length ?? 0;
  }
  rowPtr[freeDofCount] = stored;
  const colIndex = new Int32Array(stored);
  for (let row = 0; row < freeDofCount; row += 1) {
    const cols = rowScratch[row];
    if (cols === undefined) continue;
    colIndex.set(cols, rowPtr[row] ?? 0);
  }

  // The load vector over all dofs, then the value scatter and reduction.
  const forceFull = new Float64Array(dofCount);
  for (const load of spec.nodalLoads) {
    if (
      !Number.isInteger(load.node) ||
      load.node < 0 ||
      load.node >= nodeCount
    ) {
      return refuse(
        `A nodal load addresses node ${String(load.node)}, which the mesh does not carry.`,
        load.node,
      );
    }
    forceFull[load.node * 3] =
      (forceFull[load.node * 3] ?? 0) + (load.forceN[0] ?? 0);
    forceFull[load.node * 3 + 1] =
      (forceFull[load.node * 3 + 1] ?? 0) + (load.forceN[1] ?? 0);
    forceFull[load.node * 3 + 2] =
      (forceFull[load.node * 3 + 2] ?? 0) + (load.forceN[2] ?? 0);
  }

  const values = new Float64Array(stored);
  const [hx, hy, hz] = mesh.spacingM;
  const gravity = spec.gravityMPerS2;
  const centrifugal = spec.centrifugal;
  const centrifugalMultiplier =
    centrifugal === undefined
      ? 0
      : centrifugal.omegaRadPerS * centrifugal.omegaRadPerS;
  for (let element = 0; element < mesh.elementCount; element += 1) {
    const gridNode = mesh.gridNodeOfElement[element] ?? 0;
    const materialIndex = spec.cellMaterialIndex[gridNode] ?? 0;
    const material = materials[materialIndex - 1];
    if (material === undefined) {
      return refuse(
        `The element at ${String(element)} resolves no material.`,
        materialIndex,
      );
    }
    const ke = stiffnesses[materialIndex - 1] as Float64Array;
    const i = gridNode % mesh.nx;
    const j = Math.floor(gridNode / mesh.nx) % mesh.ny;
    const k = Math.floor(gridNode / (mesh.nx * mesh.ny));
    const centerX = (mesh.originM[0] ?? 0) + i * (hx ?? 1);
    const centerY = (mesh.originM[1] ?? 0) + j * (hy ?? 1);
    const centerZ = (mesh.originM[2] ?? 0) + k * (hz ?? 1);

    // Stiffness scatter (element order fixed — the accumulation order
    // per CSR entry is deterministic).
    for (let a = 0; a < 8; a += 1) {
      const nodeA = mesh.elementNode[element * 8 + a] ?? 0;
      for (let ca = 0; ca < 3; ca += 1) {
        const row = freeIndexOfDof[nodeA * 3 + ca] ?? -1;
        if (row === -1) continue;
        for (let b = 0; b < 8; b += 1) {
          const nodeB = mesh.elementNode[element * 8 + b] ?? 0;
          for (let cb = 0; cb < 3; cb += 1) {
            const col = freeIndexOfDof[nodeB * 3 + cb] ?? -1;
            if (col === -1) continue;
            const slot = slotOf(rowPtr, colIndex, row, col);
            if (slot === -1) {
              return refuse(
                "The CSR structure is missing an entry the scatter needs — an internal assembly inconsistency.",
                { row, col },
              );
            }
            values[slot] =
              (values[slot] ?? 0) + (ke[(a * 3 + ca) * 24 + (b * 3 + cb)] ?? 0);
          }
        }
      }
    }

    // The body-force family (consistent loads, element order).
    const elementLoad = hexUniformBodyLoad(hx ?? 1, hy ?? 1, hz ?? 1, [
      material.densityKgPerM3 * (gravity[0] ?? 0),
      material.densityKgPerM3 * (gravity[1] ?? 0),
      material.densityKgPerM3 * (gravity[2] ?? 0),
    ]);
    if (centrifugal !== undefined) {
      const spin = hexCentrifugalLoad(
        hx ?? 1,
        hy ?? 1,
        hz ?? 1,
        centerX,
        centerY,
        centerZ,
        centrifugal.axisPointM,
        centrifugal.axisDirection,
        material.densityKgPerM3 * centrifugalMultiplier,
      );
      for (let dof = 0; dof < 24; dof += 1) {
        elementLoad[dof] = (elementLoad[dof] ?? 0) + (spin[dof] ?? 0);
      }
    }
    if (thermalActive) {
      const alpha = material.thermalExpansionPerK;
      if (alpha === undefined) {
        return refuse(
          `The thermal-expansion load names material "${material.id}", which carries no thermalExpansionPerK — the initial-strain load would fabricate a coefficient, and the assembly declines instead.`,
          material.id,
        );
      }
      const thermal = hexThermalLoad(
        hx ?? 1,
        hy ?? 1,
        hz ?? 1,
        dMatrices[materialIndex - 1] as Float64Array,
        alpha * (spec.thermalDeltaTK?.[gridNode] ?? 0),
      );
      for (let dof = 0; dof < 24; dof += 1) {
        elementLoad[dof] = (elementLoad[dof] ?? 0) + (thermal[dof] ?? 0);
      }
    }
    for (let corner = 0; corner < 8; corner += 1) {
      const node = mesh.elementNode[element * 8 + corner] ?? 0;
      forceFull[node * 3] =
        (forceFull[node * 3] ?? 0) + (elementLoad[corner * 3] ?? 0);
      forceFull[node * 3 + 1] =
        (forceFull[node * 3 + 1] ?? 0) + (elementLoad[corner * 3 + 1] ?? 0);
      forceFull[node * 3 + 2] =
        (forceFull[node * 3 + 2] ?? 0) + (elementLoad[corner * 3 + 2] ?? 0);
    }
  }

  const forceFree = new Float64Array(freeDofCount);
  for (let dof = 0; dof < dofCount; dof += 1) {
    const free = freeIndexOfDof[dof] ?? -1;
    if (free === -1) continue;
    forceFree[free] = forceFull[dof] ?? 0;
  }

  return simOk(
    Object.freeze({
      mesh,
      nodeCount,
      elementCount: mesh.elementCount,
      dofCount,
      freeDofCount,
      fixedDofCount: dofCount - freeDofCount,
      freeIndexOfDof,
      rowPtr,
      colIndex,
      values,
      forceFree,
    }),
  );
}
