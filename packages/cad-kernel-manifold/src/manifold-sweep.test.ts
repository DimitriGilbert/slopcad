/**
 * Manifold adapter's sweep honesty tests (Phase 26.3): the engine has no
 * sweep or loft primitive (probed — its profile constructors are extrude
 * and revolve only), so the adapter declares `sweep: false` and answers
 * EVERY `sweep` call — valid input or not — with the structured
 * `kernel/unsupported-operation`, never a silent approximation.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  type GeometryKernel,
  KERNEL_ERROR_CODES,
  type ProfileSweepInput,
} from "@slopcad/cad-kernel";
import { expectKernelFailure } from "@slopcad/cad-kernel/test-utils";

import { MANIFOLD_KERNEL_CAPABILITIES } from "./manifold-kernel";
import { manifoldKernelFromRuntime } from "./manifold-kernel";
import {
  createManifoldRuntime,
  type ManifoldRuntime,
} from "./manifold-runtime";

let runtime: ManifoldRuntime;
let kernel: GeometryKernel;

beforeAll(async () => {
  runtime = await createManifoldRuntime();
  kernel = manifoldKernelFromRuntime(runtime);
});

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** A perfectly valid straight sweep a sweep-capable kernel would build. */
function validSweep(): ProfileSweepInput {
  return {
    loop: [
      { kind: "line", start: [-3, -2], end: [3, -2] },
      { kind: "line", start: [3, -2], end: [3, 2] },
      { kind: "line", start: [3, 2], end: [-3, 2] },
      { kind: "line", start: [-3, 2], end: [-3, -2] },
    ],
    path: [{ kind: "line", start: [0, 0], end: [0, 40] }],
    placement: identityPlacement,
  };
}

describe("manifold sweep (honestly unsupported)", () => {
  it("declares sweep: false in its capability profile", () => {
    expect(MANIFOLD_KERNEL_CAPABILITIES.sweep).toBe(false);
    expect(kernel.capabilities.sweep).toBe(false);
  });

  it("answers valid input with kernel/unsupported-operation, input-independent", () => {
    const failure = expectKernelFailure(
      kernel.sweep(validSweep()),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "valid sweep on Manifold",
    );
    expect(failure.message).toContain("no sweep or loft primitive");
    // The capability answer does not depend on the input's validity: a
    // degenerate path receives the SAME structured answer, because the
    // engine's limit — not the input — is what fails.
    expectKernelFailure(
      kernel.sweep({ ...validSweep(), path: [] }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "degenerate sweep on Manifold",
    );
  });
});
