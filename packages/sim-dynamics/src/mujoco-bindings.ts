/**
 * The typed seam over the npm `mujoco` wasm bindings (Phase 67b): the
 * OFFICIAL Google DeepMind build (Apache-2.0, §9 — default-bundle
 * legal), loaded once per process and memoized. This file is the ONLY
 * place the package touches the bindings' `any`-typed array fields —
 * every read and write goes through the narrow typed helpers below, so
 * the provider itself carries no `any` (the NO-SLOP law).
 *
 * Conventions pinned empirically against mujoco@3.1.16 (wasm, Node):
 *
 * - **Model compile**: MJCF arrives as a STRING; the bindings' only
 *   tested entry (`mj_loadXML`) takes a PATH, so the XML is staged into
 *   the module's emscripten MEMFS and loaded from there — no network,
 *   no filesystem outside the wasm sandbox (law S2: plain vitest node
 *   env runs it).
 * - **Free joints**: `qpos = [pos(3) world, quat(4) wxyz]`,
 *   `qvel = [lin(3) WORLD, ang(3) BODY-LOCAL]`.
 * - **Ball joints**: `R_child = R_ref · R_quat` (the quaternion composes
 *   on the child-local side); `qvel` is the angular velocity in the
 *   child's CURRENT local frame.
 * - **`cvel`** (per body): `[rot(3), tran(3)]`, world-aligned, at the
 *   body CoM. **`cfrc_int`** (per body): `[torque(3), force(3)]`,
 *   world-aligned, at the CoM — the parent's force ON the child.
 * - **`xfrc_applied`**: `[force(3), torque(3)]`, world, applied AT THE
 *   BODY CoM — and only writable through the NAMED accessor
 *   (`data.body(name).xfrc_applied`); the top-level view's writes do
 *   not reach the solve.
 * - **`mj_step` leaves `xpos`/`xquat`/`cvel` at the pre-integration
 *   state** — `mj_step1` after every step refreshes them without
 *   touching the solver's warm start.
 * - **Euler integrates `damping` implicitly and `frictionloss` as a
 *   force-limited constraint** — measured to reproduce the reference
 *   kernel's spin-down arithmetic exactly (the §7.2 cross-tolerance
 *   matrix's foundation).
 *
 * Determinism posture, stated honestly: the single-threaded wasm build
 * is run-to-run deterministic for identical inputs on the same binary
 * and platform (no threads — the `mujoco/mt` variant is NOT used — no
 * randomness, fixed iteration caps). It is NOT bitwise-portable across
 * MuJoCo versions or CPU floating-point regimes, which is why the
 * dependency is version-pinned and the provider is validated against
 * the reference kernel through tolerances, never bit-asserted (law S5).
 */

import loadMujoco, { type MainModule, type MjData, type MjModel } from "mujoco";
import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";

/** The loaded wasm module, memoized per process (one 8.6 MB instance). */
let modulePromise: Promise<MainModule> | undefined;

/**
 * Loads (once) the MuJoCo wasm module. A failed load retries on the
 * next call — the memo holds successes only.
 */
export function loadMujocoWasm(): Promise<MainModule> {
  modulePromise ??= loadMujoco().catch((cause: unknown) => {
    modulePromise = undefined;
    throw cause;
  });
  return modulePromise;
}

/** Whether the wasm module is loadable in this environment, with the failure as evidence. */
export async function probeMujocoWasm(): Promise<
  SimParseResult<MainModule, SimError>
> {
  try {
    return simOk(await loadMujocoWasm());
  } catch (cause) {
    return simFail(
      simError(
        SIM_ERROR_CODES.backendUnavailable,
        `The MuJoCo wasm module could not be loaded in this environment: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      ),
    );
  }
}

/** A monotonically increasing MEMFS path for staged model XML. */
let stagedFileCounter = 0;

/**
 * Compiles MJCF text into an `MjModel`, declining (not throwing) on a
 * parse/compile failure with MuJoCo's own message as evidence.
 */
export function compileMjcf(
  module: MainModule,
  xml: string,
): SimParseResult<{ model: MjModel; data: MjData }, SimError> {
  stagedFileCounter += 1;
  const path = `/slopcad-mechanism-${stagedFileCounter}.mjcf`;
  module.FS.writeFile(path, xml);
  try {
    const model = module.MjModel.mj_loadXML(path);
    const data = new module.MjData(model);
    return simOk({ model, data });
  } catch (cause) {
    return simFail(
      simError(
        SIM_ERROR_CODES.mechanismInvalid,
        `MuJoCo declined the compiled model: ${cause instanceof Error ? cause.message : String(cause)}`,
        xml,
      ),
    );
  }
}

/** Narrows a bindings array field to a live Float64Array (the no-`any` seam). */
export function liveView(field: unknown): Float64Array {
  if (
    typeof field === "object" &&
    field !== null &&
    "set" in field &&
    "length" in field &&
    typeof (field as Float64Array).set === "function"
  ) {
    return field as Float64Array;
  }
  throw new Error(
    "Unreachable: MuJoCo array fields are live typed-array views.",
  );
}

/** Reads `count` numbers starting at `offset` from a bindings array field. */
export function readNumbers(
  field: unknown,
  offset: number,
  count: number,
): number[] {
  const view = liveView(field);
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(view[offset + index] ?? 0);
  }
  return values;
}

/** Writes `values` starting at `offset` into a bindings array field. */
export function writeNumbers(
  field: unknown,
  offset: number,
  values: readonly number[],
): void {
  const view = liveView(field);
  for (let index = 0; index < values.length; index += 1) {
    view[offset + index] = values[index] ?? 0;
  }
}

/** The mjtObj enum values the provider addresses objects by (typed). */
export function mujocoObjIds(module: MainModule): {
  readonly body: number;
  readonly joint: number;
  readonly actuator: number;
} {
  return {
    body: module.mjtObj.mjOBJ_BODY.value,
    joint: module.mjtObj.mjOBJ_JOINT.value,
    actuator: module.mjtObj.mjOBJ_ACTUATOR.value,
  };
}

/** Resolves one named object id, declining (−1 means absent in MuJoCo). */
export function mujocoNameToId(
  module: MainModule,
  objType: number,
  model: Parameters<MainModule["mj_name2id"]>[0],
  name: string,
): number {
  return module.mj_name2id(model, objType, name);
}
