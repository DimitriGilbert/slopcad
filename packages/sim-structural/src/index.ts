/**
 * Public entry of `@slopcad/sim-structural`, the coarse voxel FEM
 * domain package (ROADMAP-SIM Phase 69a): linear-elastic statics on the
 * Phase 62 occupancy grid — uniform 8-node hexahedra over occupied
 * voxel cells (the 65 thermal cell-interpretation precedent), boundary
 * conditions as nodal fixtures and loads from face/point selections,
 * the body-force family (self-weight through the Phase 61 gravity
 * vector, centrifugal ω²·r⊥ about an axis, thermal-expansion initial
 * strain from a Phase 65 temperature field — the CHT→structural
 * chaining seam), and an owned sparse Jacobi-preconditioned CG with the
 * deterministic residual discipline and loud iteration caps (law S2 —
 * the Phase 65 solver precedent, zero dependencies). Outputs are the
 * displacement-magnitude and von Mises fields (the Phase 62 overlay
 * family's grid lattice), max deflection, and the factor of safety
 * against yield — SimResult-ready through the one S4 projection site,
 * which is precisely what Phase 70 optimizes against. The package
 * depends on `@slopcad/sim-core` alone at runtime — no React, no DOM,
 * no node APIs; this CPU kernel is the test truth (law S5). The §9
 * MFEM fidelity path (BSD-3 wasm behind a provider contract) stays the
 * raised escape hatch; coarse voxel FEM is the committed default.
 */

export {
  type StructuralSolidMaterial,
  structuralSolidMaterialFromRecord,
} from "./material";
export {
  HEX_CORNER_DIRECTIONS,
  type StructuralDomainFace,
  type StructuralHexMesh,
  STRUCTURAL_FACE_BITS,
  isStructuralDomainFace,
  structuralDomainFaceNodes,
  structuralHexMesh,
} from "./mesh";
export {
  HEX_VOIGT_ORDER,
  hexCenterStrain,
  hexCentrifugalLoad,
  hexDMatrix,
  hexStiffness,
  hexStressApply,
  hexThermalLoad,
  hexUniformBodyLoad,
  hexVonMises,
} from "./element";
export {
  type AssembledStructuralSystem,
  type StructuralAssemblySpec,
  type StructuralCentrifugalSpec,
  type StructuralNodalLoad,
  assembleStructuralSystem,
} from "./system";
export {
  STRUCTURAL_SOLVE_DEFAULTS,
  STRUCTURAL_SOLVE_DEFAULT_MAX_ITERATIONS,
  STRUCTURAL_SOLVE_DEFAULT_TOLERANCE,
  type StructuralSolverOptions,
  type StructuralSolverOutcome,
  solveStructuralSystem,
  structuralSolverOptionsProblem,
} from "./solver";
export {
  type StructuralCentrifugalInput,
  type StructuralConditionEntry,
  STRUCTURAL_DEFAULT_GRAVITY,
  type StructuralMaterialSafety,
  type StructuralRunGridFacts,
  type StructuralRunReport,
  type StructuralRunScenario,
  runStructuralScenario,
  structuralRunSimResult,
} from "./run";
export {
  STRUCTURAL_PREVIEW_CHUNK_MAX_VALUES,
  STRUCTURAL_SIM_ENGINE_ID,
  STRUCTURAL_SUPPORTED_KINDS,
  createStructuralSimEngine,
} from "./engine";
