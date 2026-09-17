/**
 * The shared contract suite run against the JSCAD adapter (Phase 23): the
 * fourth consumer of {@link defineKernelContractSuite} — after the fake
 * reference kernel, the Manifold adapter, and the OCCT adapter — and the
 * third REAL geometry engine to pass it. A fresh kernel instance per test
 * preserves per-instance ownership semantics; no runtime boot is needed
 * (JSCAD is pure JavaScript, unlike the WASM kernels' `beforeAll` boots).
 *
 * The one addition beyond the shared battery: the cross-instance
 * determinism pin. The suite itself pins same-solid determinism (the same
 * handle tessellates to the same bytes); JSCAD's pure-JS BSP iterates
 * plain arrays, so determinism also holds ACROSS instances — the same
 * scene built in two kernels produces identical soups. That pin is what
 * makes JSCAD usable as a reference oracle, so it is asserted here rather
 * than assumed.
 */

import { describe, expect, it } from "vitest";
import {
  defineKernelContractSuite,
  type GeometryKernel,
  type Tessellation,
  unwrapKernelResult,
} from "@slopcad/cad-kernel";

import { buildPlateWithHole } from "./jscad-fixtures";
import { createJscadKernel } from "./jscad-kernel";

describe("jscad kernel contract", () => {
  defineKernelContractSuite(createJscadKernel, "jscad");

  function drilledPlateTessellation(kernel: GeometryKernel): Tessellation {
    const scene = buildPlateWithHole(kernel);
    return unwrapKernelResult(kernel.tessellate(scene.result), "tessellate");
  }

  it("rebuilds the same boolean scene into identical tessellations in fresh kernel instances", () => {
    expect(drilledPlateTessellation(createJscadKernel())).toEqual(
      drilledPlateTessellation(createJscadKernel()),
    );
  });
});
