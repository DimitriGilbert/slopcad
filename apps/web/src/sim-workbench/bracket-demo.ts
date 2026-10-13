/**
 * The bracket demo's fixture data (ROADMAP-SIM Phase 69): the document
 * the `/workbench-sim` page renders in BRACKET mode — the cad-jsx demo
 * body (`@slopcad/docs-examples`'s `cadjsx/bracket`) compiled and folded
 * over a fresh document. The demo has no motor record and no scenario
 * baked in: the structural form's defaults ARE the demo (the L-bracket
 * bolted down at its base face, the wall's tip loaded in −y), stated
 * once here as the authored numbers the form restates.
 *
 * Everything here is FIXTURE DATA in the 62c sense: the domain, the
 * resolution, the fixture face, the tip point, and the tip force are
 * authored numbers tuned together at the demo scale — a 5 mm voxel grid
 * keeps the coarse FEM solve interactive (the 69a convergence tables'
 * small-grid band) while the staircase honesty stays visible.
 */

import {
  applySessionTransaction,
  createDocument,
  createDocumentId,
  createSession,
  type CadDocument,
} from "@slopcad/cad-core";
import { compileModel } from "@slopcad/cad-jsx";
import { BRACKET, BracketModel } from "@slopcad/docs-examples/cadjsx/bracket";

/** The bracket demo document's id. */
export const BRACKET_DEMO_DOCUMENT_ID = "doc_workbench_sim_bracket";

/** The bracket demo's authored numbers — the form defaults' single source. */
export const BRACKET_DEMO = {
  /** The explicit voxelization domain around the bracket, mm. */
  domainMinMm: [-BRACKET.baseHalfX, -BRACKET.baseHalfY, 0] as readonly [
    number,
    number,
    number,
  ],
  domainMaxMm: [
    BRACKET.baseHalfX,
    BRACKET.baseHalfY,
    BRACKET.wallHeight,
  ] as readonly [number, number, number],
  /** The voxel resolution, mm (the honest staircase scale). */
  resolutionMm: 5,
  /** The fixture face: the base plate's bolted-down bottom plane. */
  fixtureFace: "zMin" as const,
  /** The tip-load application point, mm (the wall's top centre). */
  tipPointMm: [...BRACKET.tipPointMm] as readonly [number, number, number],
  /** The tip-load force, N (pushing the wall in −y). */
  tipForceN: [0, -500, 0] as readonly [number, number, number],
  /** The hot-bracket chain's stress-free reference temperature, K. */
  referenceTemperatureK: 293.15,
} as const;

/**
 * The demo document: the bracket's two bodies (the base plate and the
 * upright wall). Pure and deterministic (the compile walk is), computed
 * once per call site — the sim-demo-body precedent.
 */
export function bracketDemoDocument(): CadDocument {
  const compiled = compileModel(BracketModel());
  if (!compiled.ok) {
    throw new Error(
      `The bracket model failed to compile: ${compiled.error.code}: ${compiled.error.message}`,
    );
  }
  const applied = applySessionTransaction(
    createSession(createDocument(createDocumentId(BRACKET_DEMO_DOCUMENT_ID))),
    compiled.value,
  );
  if (!applied.ok) {
    throw new Error(
      `The bracket transaction did not apply to a fresh document: ${applied.error.message}`,
    );
  }
  return applied.value.document;
}
