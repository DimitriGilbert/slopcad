/**
 * Manifold adapter's loft honesty tests (Phase 26.4): the engine has no
 * loft primitive (probed — its constructors are extrude, revolve, hull,
 * and levelSet; extrude's twist/scale options cover only single-polygon
 * two-station specials), so the adapter declares `loft: false` and
 * answers EVERY `loft` call — valid input or not — with the structured
 * `kernel/unsupported-operation`, never a silent approximation. The
 * sweep convention, applied again.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  type GeometryKernel,
  KERNEL_ERROR_CODES,
  type ProfileLoftInput,
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

/** A perfectly valid prismatic loft a loft-capable kernel would build. */
function validLoft(): ProfileLoftInput {
  const square = (z: number) => ({
    loop: [
      {
        kind: "line" as const,
        start: [-5, -5] as [number, number],
        end: [5, -5] as [number, number],
      },
      {
        kind: "line" as const,
        start: [5, -5] as [number, number],
        end: [5, 5] as [number, number],
      },
      {
        kind: "line" as const,
        start: [5, 5] as [number, number],
        end: [-5, 5] as [number, number],
      },
      {
        kind: "line" as const,
        start: [-5, 5] as [number, number],
        end: [-5, -5] as [number, number],
      },
    ],
    z: length(z),
  });
  return {
    sections: [square(0), square(40)],
    placement: identityPlacement,
  };
}

describe("manifold loft (honestly unsupported)", () => {
  it("declares loft: false in its capability profile", () => {
    expect(MANIFOLD_KERNEL_CAPABILITIES.loft).toBe(false);
    expect(kernel.capabilities.loft).toBe(false);
  });

  it("answers valid input with kernel/unsupported-operation, input-independent", () => {
    const failure = expectKernelFailure(
      kernel.loft(validLoft()),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "valid loft on Manifold",
    );
    expect(failure.message).toContain("no loft primitive");
    // The capability answer does not depend on the input's validity: a
    // degenerate collection receives the SAME structured answer, because
    // the engine's limit — not the input — is what fails.
    expectKernelFailure(
      kernel.loft({ ...validLoft(), sections: [] }),
      KERNEL_ERROR_CODES.unsupportedOperation,
      "degenerate loft on Manifold",
    );
  });
});
