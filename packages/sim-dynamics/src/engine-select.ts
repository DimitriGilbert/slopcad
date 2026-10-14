/**
 * The engine-selection seam (Phase 67b, for 67c's routing): ONE factory
 * behind which the reference kernel and the MuJoCo provider are
 * interchangeable `DynamicsEngine`s over the same contract. The DEFAULT
 * is the reference kernel — the deterministic zero-dependency ORACLE
 * (laws S2/S5); MuJoCo is the OPT-IN performance provider (§7.2's
 * ruling), selected explicitly and declining loudly when its wasm
 * cannot load, never silently falling back to the reference.
 *
 * The factory is async because the MuJoCo wasm module loads once per
 * process; the reference branch resolves immediately. The returned
 * engines' `build`/`step` stay synchronous per the contract.
 */

import { type SimError, type SimParseResult, simOk } from "@slopcad/sim-core";
import type { DynamicsEngine } from "./contract";

import { createReferenceDynamicsEngine } from "./engine";
import { createMujocoDynamicsEngine } from "./mujoco-provider";

/** The selectable dynamics engines behind the contract. */
export type DynamicsEngineChoice = "reference" | "mujoco";

/** The default engine: the TS reference kernel — the S2/S5 oracle. */
export const DEFAULT_DYNAMICS_ENGINE: DynamicsEngineChoice = "reference";

/**
 * Creates the selected engine. `"reference"` resolves synchronously
 * wrapped; `"mujoco"` loads the wasm module once and declines as
 * `sim/backend-unavailable` when the environment cannot run it.
 */
export async function createDynamicsEngine(
  choice: DynamicsEngineChoice = DEFAULT_DYNAMICS_ENGINE,
): Promise<SimParseResult<DynamicsEngine, SimError>> {
  switch (choice) {
    case "reference":
      return simOk(createReferenceDynamicsEngine());
    case "mujoco":
      return createMujocoDynamicsEngine();
  }
}
