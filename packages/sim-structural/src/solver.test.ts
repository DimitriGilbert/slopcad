/**
 * The owned solver's discipline (Phase 69a): the CG contract — knob
 * validation, the zero-load early exit, the exactness of the solve on
 * the assembled system (the residual the report claims is the residual
 * the system carries), and the LOUD iteration cap (never a fabricated
 * converged field).
 */

import { describe, expect, it } from "vitest";
import { SIM_ERROR_CODES } from "@slopcad/sim-core";
import type {
  AssembledStructuralSystem,
  StructuralAssemblySpec,
} from "./system";

import { assembleStructuralSystem } from "./system";
import {
  STRUCTURAL_SOLVE_DEFAULTS,
  solveStructuralSystem,
  structuralSolverOptionsProblem,
} from "./solver";
import { boxGrid, steelScenario, uniformMaterialIndex } from "./fixtures";
import { structuralHexMesh } from "./mesh";

const GRID = boxGrid(6, 2, 2, 0.005);

/** The bar with its xMin face fully fixed; gravity off by default. */
function baseSpec(
  overrides: Partial<StructuralAssemblySpec> = {},
): StructuralAssemblySpec {
  const meshResult = structuralHexMesh(GRID);
  if (!meshResult.ok) throw new Error(meshResult.error.message);
  const mesh = meshResult.value;
  const fixedDofMask = new Uint8Array(mesh.nodeCount * 3);
  for (let node = 0; node < mesh.nodeCount; node += 1) {
    if ((mesh.nodeFaceMask[node] ?? 0) & 1) {
      fixedDofMask[node * 3] = 1;
      fixedDofMask[node * 3 + 1] = 1;
      fixedDofMask[node * 3 + 2] = 1;
    }
  }
  return {
    mesh,
    materials: steelScenario(GRID).materials,
    cellMaterialIndex: uniformMaterialIndex(GRID),
    gravityMPerS2: [0, 0, 0],
    fixedDofMask,
    nodalLoads: [],
    ...overrides,
  };
}

/** A free far-x node of the base mesh (a load point the fixtures miss). */
function freeTipNode(mesh: AssembledStructuralSystem["mesh"]): number {
  let freeNode = 0;
  let maxX = Number.NEGATIVE_INFINITY;
  for (let node = 0; node < mesh.nodeCount; node += 1) {
    const x = mesh.nodePositionM[node * 3] ?? 0;
    const fixed = (mesh.nodeFaceMask[node] ?? 0) & 1;
    if (fixed === 0 && x > maxX) {
      maxX = x;
      freeNode = node;
    }
  }
  return freeNode;
}

function mustAssemble(spec: StructuralAssemblySpec): AssembledStructuralSystem {
  const built = assembleStructuralSystem(spec);
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

describe("the structural solver discipline", () => {
  it("validates its knobs", () => {
    expect(
      structuralSolverOptionsProblem({ tolerance: 0, maxIterations: 10 }),
    ).toBeDefined();
    expect(
      structuralSolverOptionsProblem({
        tolerance: Number.NaN,
        maxIterations: 10,
      }),
    ).toBeDefined();
    expect(
      structuralSolverOptionsProblem({ tolerance: 1e-10, maxIterations: 0 }),
    ).toBeDefined();
    expect(structuralSolverOptionsProblem(STRUCTURAL_SOLVE_DEFAULTS)).toBe(
      undefined,
    );
  });

  it("returns u = 0 for a zero load without iterating", () => {
    const solved = solveStructuralSystem(
      mustAssemble(baseSpec()),
      STRUCTURAL_SOLVE_DEFAULTS,
    );
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    expect(solved.value.outcome.iterations).toBe(0);
    expect(solved.value.displacementFree.every((value) => value === 0)).toBe(
      true,
    );
  });

  it("stops with a residual the system itself confirms", () => {
    const mesh = mustAssemble(baseSpec()).mesh;
    const loaded = mustAssemble(
      baseSpec({
        nodalLoads: [{ node: freeTipNode(mesh), forceN: [0, -10, 0] }],
      }),
    );
    const solved = solveStructuralSystem(loaded, {
      tolerance: 1e-10,
      maxIterations: 20_000,
    });
    expect(solved.ok).toBe(true);
    if (!solved.ok) return;
    const { displacementFree, outcome } = solved.value;
    // Recompute ‖b − A·u‖₂/‖b‖₂ from the CSR directly — the reported
    // residual is the system's own, not a claim.
    const residual = new Float64Array(loaded.freeDofCount);
    for (let row = 0; row < loaded.freeDofCount; row += 1) {
      let value = loaded.forceFree[row] ?? 0;
      for (
        let slot = loaded.rowPtr[row] ?? 0;
        slot < (loaded.rowPtr[row + 1] ?? 0);
        slot += 1
      ) {
        value -=
          (loaded.values[slot] ?? 0) *
          (displacementFree[loaded.colIndex[slot] ?? 0] ?? 0);
      }
      residual[row] = value;
    }
    let r2 = 0;
    let b2 = 0;
    for (let row = 0; row < loaded.freeDofCount; row += 1) {
      r2 += (residual[row] ?? 0) ** 2;
      b2 += (loaded.forceFree[row] ?? 0) ** 2;
    }
    expect(Math.sqrt(b2)).toBeGreaterThan(0);
    expect(Math.sqrt(r2) / Math.sqrt(b2)).toBeLessThanOrEqual(1.0000001e-10);
    expect(outcome.relativeResidual).toBeLessThanOrEqual(1e-10);
    expect(outcome.iterations).toBeGreaterThan(0);
  });

  it("declines loudly when the iteration cap is exhausted", () => {
    const mesh = mustAssemble(baseSpec()).mesh;
    const loaded = mustAssemble(
      baseSpec({
        nodalLoads: [{ node: freeTipNode(mesh), forceN: [0, -10, 0] }],
      }),
    );
    const solved = solveStructuralSystem(loaded, {
      tolerance: 1e-10,
      maxIterations: 1,
    });
    expect(solved.ok).toBe(false);
    if (!solved.ok) {
      expect(solved.error.code).toBe(SIM_ERROR_CODES.solverUnconverged);
      expect(solved.error.message).toContain("cap");
    }
  });

  it("declines a system whose rows carry a non-positive diagonal", () => {
    // A doctored CSR: a zero diagonal row — the fixture-starved posture.
    const system = mustAssemble(baseSpec());
    const values = Float64Array.from(system.values);
    for (
      let slot = system.rowPtr[0] ?? 0;
      slot < (system.rowPtr[1] ?? 0);
      slot += 1
    ) {
      if ((system.colIndex[slot] ?? -1) === 0) values[slot] = 0;
    }
    const doctored: AssembledStructuralSystem = { ...system, values };
    const solved = solveStructuralSystem(doctored, STRUCTURAL_SOLVE_DEFAULTS);
    expect(solved.ok).toBe(false);
    if (!solved.ok) {
      expect(solved.error.message).toContain("SPD");
    }
  });
});
