/**
 * The drawing section derivation against the kernel's Phase 46 section
 * (Phase 55): the cad-core mesh/plane derivation's cut-face area must
 * match the kernel-measured `section.areaMm2` for the same body and plane
 * — the roadmap's "section area matches Phase 46 kernel section" fixture,
 * pinned on the Manifold engine (in-memory wasm; the same equality the
 * OCCT kernel answers analytically for the box, see its own section
 * fixtures).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import { meshPlaneCrossSection, polygonArea } from "@slopcad/cad-core";
import { unwrapKernelResult } from "@slopcad/cad-kernel";

import { manifoldKernelFromRuntime } from "./manifold-kernel";
import {
  createManifoldRuntime,
  type ManifoldRuntime,
} from "./manifold-runtime";

let runtime: ManifoldRuntime;

beforeAll(async () => {
  runtime = await createManifoldRuntime();
});

describe("the drawing section derivation vs the kernel section", () => {
  it("matches the kernel-measured cut-face area on a box mid-cut", () => {
    const kernel = manifoldKernelFromRuntime(runtime);
    const W = 30;
    const D = 20;
    const H = 10;
    const box = unwrapKernelResult(
      kernel.createBox({
        width: length(W),
        depth: length(D),
        height: length(H),
      }),
    );
    const plane = {
      origin: [length(0), length(0), length(H / 2)] as const,
      normal: [0, 0, 1] as const,
      keepSide: 1 as const,
    };
    const cut = unwrapKernelResult(kernel.section({ target: box, ...plane }));
    expect(cut.section.areaMm2).toBeCloseTo(W * D, 6);

    // The drawing derivation over the SAME body's tessellation.
    const tessellation = unwrapKernelResult(kernel.tessellate(box));
    const loops = meshPlaneCrossSection(
      {
        positions: tessellation.positions,
        indices: tessellation.indices,
      },
      { origin: [0, 0, H / 2], normal: [0, 0, 1], keepSide: 1 },
    );
    expect(loops.loops.length).toBeGreaterThan(0);
    const derivedArea = loops.loops.reduce(
      (sum, loop) => sum + polygonArea(loop),
      0,
    );
    expect(derivedArea).toBeCloseTo(cut.section.areaMm2, 5);
  });
});
