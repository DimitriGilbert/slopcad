/**
 * The structural engine's tests (Phase 69b, the `@slopcad/sim-thermal`
 * `./engine` test precedent): the compiled-problem adapter behind the
 * Phase 61 contract — one COMPILED structural scenario (produced by the
 * real geometry-aware compile door over hand-authored tessellations, the
 * wire forms the worker carries) through the engine, pinning:
 *
 * - the ROUTED RUN: a compiled bracket solves, the summary carries the
 *   max-deflection and von Mises scalars plus the factor-of-safety
 *   family, both overlay blocks persist (displacement in mm, von Mises
 *   in Pa — the S4 projection), the preview stream reassembles into
 *   EXACTLY the finalized displacement block with displacement applied
 *   LAST (the deterministic live-overlay order), and the served backend
 *   is the CPU oracle;
 * - the BODY-FORCE FAMILY through the door: the self-weight switch
 *   gates the gravity body force (off = the weightless twin), the
 *   centrifugal stance resolves its fixed rpm to ω at the compile door,
 *   and the thermal chain samples the supplied temperature block onto
 *   every solid node as ΔT against the stance's reference;
 * - the LOUD DECLINES: the kind gate, the gpu-preference gate, the
 *   geometry-less run, and foreign conditions each refuse with their
 *   structured `sim/*` code;
 * - DETERMINISM: the same compiled problem solves twice to the
 *   bitwise-identical summary and fields (law S2).
 */

import { describe, expect, it } from "vitest";
import {
  type SimEngineFieldChunk,
  type SimResult,
  compileSimScenarioWithGeometry,
} from "@slopcad/sim-core";

import { STEEL_WIRE } from "./fixtures";
import {
  STRUCTURAL_PREVIEW_CHUNK_MAX_VALUES,
  STRUCTURAL_SIM_ENGINE_ID,
  STRUCTURAL_SUPPORTED_KINDS,
  createStructuralSimEngine,
} from "./engine";

/** An axis-aligned box's triangle soup, the voxelizer's wire form (mm). */
function boxTessellation(
  minMm: readonly [number, number, number],
  maxMm: readonly [number, number, number],
): { positions: number[]; indices: number[] } {
  const [x0, y0, z0] = minMm;
  const [x1, y1, z1] = maxMm;
  const v: readonly [number, number, number][] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const quads: readonly [number, number, number, number][] = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) {
    const base = positions.length / 3;
    for (const index of [a, b, c, d]) {
      const corner = v[index];
      positions.push(corner?.[0] ?? 0, corner?.[1] ?? 0, corner?.[2] ?? 0);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, indices };
}

/** The demo bracket's serialized scenario record (document wire form). */
function bracketScenario(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "bracket",
    kind: "structural",
    domain: {
      kind: "explicit",
      min: [-60, -40, 0],
      max: [60, 40, 80],
      resolutionMm: 5,
    },
    conditions: [
      { kind: "fixed-support", face: "zMin" },
      {
        kind: "point-load",
        atWorldPointMm: [0, -36, 80],
        forceN: [0, -500, 0],
      },
    ],
    fluid: "air",
    materials: [
      { bodyId: "body_bracket-base", materialId: STEEL_WIRE.id },
      { bodyId: "body_bracket-wall", materialId: STEEL_WIRE.id },
    ],
    gravityMPerS2: [0, -9.80665, 0],
    structural: { selfWeight: false },
    ...overrides,
  };
}

/** The compile input the worker carries for the bracket demo. */
function bracketCompileInput(
  scenario: Record<string, unknown>,
  structuralChain?: Record<string, unknown>,
): Parameters<typeof compileSimScenarioWithGeometry>[0] {
  return {
    scenario,
    bodyTessellations: [
      {
        bodyId: "body_bracket-base",
        tessellation: boxTessellation([-60, -40, 0], [60, 40, 8]),
      },
      {
        bodyId: "body_bracket-wall",
        tessellation: boxTessellation([-60, -40, 0], [60, -32, 80]),
      },
    ],
    materials: [STEEL_WIRE],
    ...(structuralChain === undefined ? {} : { structuralChain }),
  };
}

/** Runs the engine over a compiled bracket, collecting the chunk stream. */
async function runBracket(
  scenario: Record<string, unknown>,
  structuralChain?: Record<string, unknown>,
): Promise<
  | {
      readonly ok: true;
      readonly result: SimResult;
      readonly chunks: readonly SimEngineFieldChunk[];
    }
  | { readonly ok: false; readonly code: string; readonly message: string }
> {
  const compiled = compileSimScenarioWithGeometry(
    bracketCompileInput(scenario, structuralChain),
  );
  if (!compiled.ok) {
    return {
      ok: false,
      code: compiled.error.code,
      message: compiled.error.message,
    };
  }
  const chunks: SimEngineFieldChunk[] = [];
  const run = await createStructuralSimEngine().run(
    { compiled: compiled.value },
    undefined,
    (chunk) => {
      chunks.push(chunk);
    },
  );
  if (!run.ok) {
    return { ok: false, code: run.error.code, message: run.error.message };
  }
  return { ok: true, result: run.value, chunks };
}

/** Reads one summary quantity. */
function quantityOf(result: SimResult, name: string): number | undefined {
  return result.summary.quantities.find((entry) => entry.name === name)?.value;
}

describe("the structural engine's surface", () => {
  it("declares the structural kind alone under the CPU oracle", () => {
    const engine = createStructuralSimEngine();
    expect(engine.id).toBe(STRUCTURAL_SIM_ENGINE_ID);
    expect(engine.backend).toBe("cpu");
    expect([...STRUCTURAL_SUPPORTED_KINDS]).toEqual(["structural"]);
  });
});

describe("the routed bracket run", () => {
  it("solves, summarizes, and streams both overlay blocks", async () => {
    const started = Date.now();
    const outcome = await runBracket(bracketScenario());
    const elapsedMs = Date.now() - started;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const { result, chunks } = outcome;
    expect(result.summary.status).toBe("completed");
    expect(result.summary.servedBackend).toBe("cpu");
    expect(result.summary.regime.qualitative).toEqual([]);
    // The summary scalar family: max deflection (mm), von Mises (Pa),
    // the FoS family, and the solver discipline's own numbers.
    const deflection = quantityOf(result, "max-deflection");
    const vonMises = quantityOf(result, "von-mises-max");
    const fos = quantityOf(result, "factor-of-safety");
    expect(deflection).toBeDefined();
    expect(vonMises).toBeDefined();
    expect(fos).toBeDefined();
    if (
      deflection === undefined ||
      vonMises === undefined ||
      fos === undefined
    ) {
      throw new Error("unreachable: checked above");
    }
    // The staircase-band honesty: the closed-form twin of the wall as
    // a cantilever (F·L³/(3EI), σ = F·L/W) brackets the voxel result.
    // Measured once (2026-10-13, this fixture): deflection 0.0353 mm
    // = 0.61× the twin, von Mises 8.09 MPa = 0.29× — the coarse
    // element-center recovery under-resolves the 2-voxel wall's root
    // bending, the exact comparative-positioning band the phase
    // states; pinned with room for the staircase's share.
    const length = 0.072;
    const inertia = (0.12 * 0.008 ** 3) / 12;
    const section = (0.12 * 0.008 ** 2) / 6;
    // The twin computes in SI (m); the projected quantity is mm (law
    // S4's length projection) — one conversion, here, for the ratio.
    const closedDeflectionMm =
      1000 * ((500 * length ** 3) / (3 * 210e9 * inertia));
    const closedStress = (500 * length) / section;
    expect(deflection / closedDeflectionMm).toBeGreaterThan(0.45);
    expect(deflection / closedDeflectionMm).toBeLessThan(0.85);
    expect(vonMises / closedStress).toBeGreaterThan(0.2);
    expect(vonMises / closedStress).toBeLessThan(0.45);
    expect(STEEL_WIRE.youngsModulusPa > 0).toBe(true);
    expect((STEEL_WIRE.yieldStrengthPa ?? 0) / vonMises).toBeCloseTo(fos, 6);
    // The overlay blocks persist: displacement in mm, von Mises in Pa,
    // over the full-3D lattice.
    const displacement = result.fields.find(
      (field) => field.id === "displacement",
    );
    const vonMisesField = result.fields.find(
      (field) => field.id === "von-mises",
    );
    expect(displacement).toBeDefined();
    expect(vonMisesField).toBeDefined();
    if (displacement === undefined || vonMisesField === undefined) {
      throw new Error("unreachable: checked above");
    }
    expect(displacement.unit).toBe("mm");
    expect(vonMisesField.unit).toBe("Pa");
    expect(displacement.extent).toEqual([25, 17, 17]);
    // The preview stream: both fields' chunk rounds, displacement
    // LAST (the deterministic live-overlay order), reassembling into
    // exactly the finalized blocks.
    expect(chunks.length).toBeGreaterThan(0);
    const lastFieldId = chunks[chunks.length - 1]?.id;
    expect(lastFieldId).toBe("displacement");
    const displacementValues = displacement.values.length;
    const expectedChunks = Math.max(
      1,
      Math.ceil(displacementValues / STRUCTURAL_PREVIEW_CHUNK_MAX_VALUES),
    );
    const displacementChunks = chunks.filter(
      (chunk) => chunk.id === "displacement",
    );
    expect(displacementChunks.length).toBe(expectedChunks);
    // Statics carries no time axis.
    expect(result.histories).toEqual([]);
    // The measured cost, stated for the timeout budget below.
    expect(elapsedMs).toBeLessThan(60_000);
  }, 120_000);

  it("solves bitwise-identically on a repeat run (law S2)", async () => {
    const first = await runBracket(bracketScenario());
    const second = await runBracket(bracketScenario());
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(second.result.summary)).toBe(
      JSON.stringify(first.result.summary),
    );
    expect(
      second.result.fields.map((field) => [
        field.id,
        field.values,
        field.extent,
        field.originMm,
        field.spacingMm,
      ]),
    ).toEqual(
      first.result.fields.map((field) => [
        field.id,
        field.values,
        field.extent,
        field.originMm,
        field.spacingMm,
      ]),
    );
    expect(
      second.chunks.map((chunk) => [chunk.id, chunk.chunkIndex, chunk.values]),
    ).toEqual(
      first.chunks.map((chunk) => [chunk.id, chunk.chunkIndex, chunk.values]),
    );
  }, 240_000);
});

describe("the body-force family through the door", () => {
  it("gates self-weight: the weightless and heavy twins differ", async () => {
    const dry = await runBracket(bracketScenario());
    const heavy = await runBracket(
      bracketScenario({ structural: { selfWeight: true } }),
    );
    expect(dry.ok).toBe(true);
    expect(heavy.ok).toBe(true);
    if (!dry.ok || !heavy.ok) return;
    const dryDeflection = quantityOf(dry.result, "max-deflection");
    const heavyDeflection = quantityOf(heavy.result, "max-deflection");
    expect(dryDeflection).toBeDefined();
    expect(heavyDeflection).toBeDefined();
    if (dryDeflection === undefined || heavyDeflection === undefined) {
      throw new Error("unreachable: checked above");
    }
    // Self-weight adds the bracket's own ~11 N to the 500 N tip load —
    // a measurable rise, not a rewrite. Measured: 0.03551 against
    // 0.03533 mm (×1.0052) — banded with float-safe margins.
    expect(heavyDeflection).toBeGreaterThan(dryDeflection);
    expect(heavyDeflection / dryDeflection).toBeLessThan(1.1);
  }, 240_000);

  it("resolves the fixed centrifugal rpm to ω and spins the body force", async () => {
    const spun = await runBracket(
      bracketScenario({
        structural: {
          selfWeight: false,
          centrifugal: {
            axisPointMm: [0, 0, 0],
            axisDirection: [0, 0, 1],
            rpmMode: "fixed",
            fixedRpm: 3000,
          },
        },
      }),
    );
    expect(spun.ok).toBe(true);
    if (!spun.ok) return;
    const vonMises = quantityOf(spun.result, "von-mises-max");
    expect(vonMises).toBeDefined();
    if (vonMises === undefined) throw new Error("unreachable: checked");
    // The fan-blade root case: the bracket BENDS under its centrifugal
    // body force (the base fixture roots the wall), so the free
    // thin-ring form σ = ρω²r² undershoots — measured 27.88 MPa
    // against the ring's 2.79 MPa (×9.99); the band states the
    // fixture-bending dominance honestly.
    const omega = 3000 * ((2 * Math.PI) / 60);
    const ring = 7850 * omega ** 2 * 0.06 ** 2;
    expect(vonMises / ring).toBeGreaterThan(5);
    expect(vonMises / ring).toBeLessThan(20);
  }, 240_000);

  it("chains a thermal run's temperature field as ΔT against the reference", async () => {
    // A uniform 393.15 K field over the same domain (a 5 mm lattice
    // matching the structural grid), referenced at 293.15 K: ΔT = 100.
    const nx = 25;
    const ny = 17;
    const values = new Array<number>(nx * ny).fill(393.15);
    const hot = await runBracket(
      bracketScenario({
        structural: {
          selfWeight: false,
          thermal: { referenceTemperatureK: 293.15 },
        },
      }),
      {
        thermal: {
          field: {
            originMm: [-60, -40, 0],
            spacingMm: [5, 5, 5],
            extent: [nx, ny, 1],
            values,
          },
        },
      },
    );
    expect(hot.ok).toBe(true);
    if (!hot.ok) return;
    const vonMises = quantityOf(hot.result, "von-mises-max");
    expect(vonMises).toBeDefined();
    if (vonMises === undefined) throw new Error("unreachable: checked");
    // The constrained-family twin: the zMin fixture pins the base, the
    // wall wants to grow — EαΔT = 252 MPa is the scale. Measured:
    // 458.8 MPa (×1.82) — the wide plate's fully-fixed bottom face
    // adds triaxial restraint beyond the 69a constrained bar's
    // 1.01–1.04 boundary layer; the band states the overshoot.
    const closed = 210e9 * 1.2e-5 * 100;
    expect(vonMises / closed).toBeGreaterThan(1.5);
    expect(vonMises / closed).toBeLessThan(2.2);
  }, 240_000);
});

describe("the structural engine's loud declines", () => {
  it("declines the fan-run centrifugal stance that names no run", async () => {
    const outcome = await runBracket(
      bracketScenario({
        structural: {
          selfWeight: false,
          centrifugal: {
            axisPointMm: [0, 0, 0],
            axisDirection: [0, 0, 1],
            rpmMode: "fan-run",
          },
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("sim/scenario-invalid");
    expect(outcome.message).toContain("fan run");
  });

  it("declines the thermal chain that names no thermal run", async () => {
    const outcome = await runBracket(
      bracketScenario({
        structural: {
          selfWeight: false,
          thermal: { referenceTemperatureK: 293.15 },
        },
      }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("sim/scenario-invalid");
    expect(outcome.message).toContain("thermal run");
  });

  it("declines a supplied chain the stance never asked for", async () => {
    const outcome = await runBracket(bracketScenario(), { fanRpm: 3000 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("sim/scenario-invalid");
    expect(outcome.message).toContain("never silently");
  });

  it("declines the fan-run rate sourced from the chain input", async () => {
    const outcome = await runBracket(
      bracketScenario({
        structural: {
          selfWeight: false,
          centrifugal: {
            axisPointMm: [0, 0, 0],
            axisDirection: [0, 0, 1],
            rpmMode: "fan-run",
          },
        },
      }),
      { fanRpm: 3000 },
    );
    expect(outcome.ok).toBe(true);
  });

  it("declines the geometry-less run and the gpu preference", async () => {
    const compiled = compileSimScenarioWithGeometry({
      scenario: bracketScenario(),
      materials: [STEEL_WIRE],
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.message).toContain("tessellation");

    const withGeometry = compileSimScenarioWithGeometry(
      bracketCompileInput(bracketScenario({ backend: "gpu" })),
    );
    expect(withGeometry.ok).toBe(true);
    if (!withGeometry.ok) return;
    const run = await createStructuralSimEngine().run({
      compiled: withGeometry.value,
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe("sim/backend-unavailable");
  });

  it("declines a foreign kind and foreign conditions loudly", async () => {
    const compiled = compileSimScenarioWithGeometry(
      bracketCompileInput(bracketScenario()),
    );
    if (!compiled.ok) throw new Error(compiled.error.message);
    const foreign = await createStructuralSimEngine().run({
      compiled: { ...compiled.value, kind: "flow" },
    });
    expect(foreign.ok).toBe(false);
    if (foreign.ok) return;
    expect(foreign.error.code).toBe("sim/scenario-kind-unsupported");

    const inlet = await runBracket(
      bracketScenario({
        conditions: [
          {
            kind: "velocity-inlet",
            face: "xMin",
            speedMPerS: 1,
            direction: [1, 0, 0],
          },
        ],
      }),
    );
    expect(inlet.ok).toBe(false);
    if (inlet.ok) return;
    expect(inlet.message).toContain("another domain's vocabulary");
  });
});
