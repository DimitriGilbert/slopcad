/**
 * The deterministic fake sim engine (Phase 61b): a fast, dependency-free
 * reference implementation of the {@link SimEngine} contract — the
 * `fake-kernel` precedent (`@slopcad/cad-kernel`'s `fake-kernel`) carried
 * to the simulation spine. It exists so the contract, the `sim.*` worker
 * vocabulary, and the notification class can be exercised end to end in
 * tests before any real solver exists (Phase 63's LBM kernel is the first),
 * and it defines the baseline semantics every real engine must reproduce:
 * scheduled progress, synthetic field-chunk streams whose final round
 * reassembles to exactly the finalized result's blocks, honest structured
 * declines for unsupported kinds and backends, cooperative cancellation
 * (callback throws unwind the run; see `./engine`), and bitwise determinism
 * — the same compiled scenario produces the same result and the same
 * emission schedule, every time.
 *
 * ## The synthetic physics (deterministic arithmetic, no solver)
 *
 * The grid is derived from the compiled domain (sample counts clamped to
 * small axes — a fake stays cheap), and every field value is a pure
 * function of the cell indices, the compiled scenario's SI scalars (inlet
 * speed, fluid state, domain measures), and the step counter: a smooth
 * sine/cosine cell profile scaled by a step ramp. The finalized scalars
 * ride the S4 projection (`projectSimResult`) like a real engine's would;
 * the histories are deterministic sample sequences over the step count.
 *
 * ## The emission schedule
 *
 * One progress notification per step, and a field-chunk round every
 * {@link FAKE_SIM_ENGINE_STEPS}/{@link FAKE_SIM_ENGINE_CHUNK_ROUNDS} steps
 * — each round publishes every field, split into
 * {@link FAKE_SIM_ENGINE_FIELD_CHUNKS} chunks through the deterministic
 * splitter (`./sim-field-chunks`). The LAST round publishes exactly the
 * blocks the finalized {@link SimResult} carries, so a host that applies
 * chunk streams as committed applications (law S6) and then finalizes sees
 * one lossless story: reassembled final round == finalized blocks ==
 * payload bytes.
 *
 * ## The yields
 *
 * Each step awaits one macrotask turn (`setTimeout` 0) so the hosting
 * channel can deliver a cancel message mid-run — the cooperative
 * cancellation window the worker server's wrappers exercise. Nothing else
 * about the engine depends on time: the emission schedule is step-counted,
 * never clock-counted.
 */

import type {
  SimEngine,
  SimEngineFieldChunk,
  SimEngineProgress,
  SimEngineRequest,
} from "./engine";
import type { SimError } from "./errors";
import type { SimResult, SimResultFieldBlock } from "./sim-result";
import type { SimParseResult } from "./result";
import type { SimScenarioKind } from "./vocabulary";
import type { SimProjectedQuantity, SolverSimScalar } from "./units";

import { SIM_ERROR_CODES, simError } from "./errors";
import { splitSimFieldBlock } from "./sim-field-chunks";
import { MM_PER_M, projectSimResult } from "./units";
import { SIM_RESULT_SUMMARY_VERSION } from "./sim-result";

/** The fake engine's stable id. */
export const FAKE_SIM_ENGINE_ID = "fake-sim";

/** Total steps of one fake run (a fixed constant, like the fake kernel's). */
export const FAKE_SIM_ENGINE_STEPS = 24;

/** Field-chunk emission rounds per run (at even step intervals). */
export const FAKE_SIM_ENGINE_CHUNK_ROUNDS = 3;

/** Chunks per field per round. */
export const FAKE_SIM_ENGINE_FIELD_CHUNKS = 4;

/** The grid axes' per-axis sample budget (a fake stays cheap). */
const FAKE_SIM_ENGINE_MAX_AXIS_SAMPLES = 8;

/** The scenario kinds the fake engine solves. */
const SUPPORTED_KINDS: readonly SimScenarioKind[] = ["flow", "thermal"];

/** The largest inlet velocity magnitude across the compiled conditions, m/s. */
function inletSpeedMPerS(request: SimEngineRequest): number {
  let speed = 0;
  for (const condition of request.compiled.conditions) {
    const velocity = condition.velocityMPerS;
    if (velocity === undefined) continue;
    const magnitude = Math.sqrt(
      (velocity[0] ?? 0) ** 2 +
        (velocity[1] ?? 0) ** 2 +
        (velocity[2] ?? 0) ** 2,
    );
    speed = Math.max(speed, magnitude);
  }
  return speed === 0 ? 1 : speed;
}

/** The engine's derived grid: sample counts per axis from the domain/cell. */
function gridExtent(
  request: SimEngineRequest,
): readonly [number, number, number] {
  const { domainMinM, domainMaxM, cellSizeM } = request.compiled;
  const axisSamples = (min: number, max: number): number => {
    const samples = Math.round((max - min) / cellSizeM);
    return Math.min(
      FAKE_SIM_ENGINE_MAX_AXIS_SAMPLES,
      Math.max(1, Number.isFinite(samples) ? samples : 1),
    );
  };
  return [
    axisSamples(domainMinM[0] ?? 0, domainMaxM[0] ?? 0),
    axisSamples(domainMinM[1] ?? 0, domainMaxM[1] ?? 0),
    axisSamples(domainMinM[2] ?? 0, domainMaxM[2] ?? 0),
  ];
}

/** One document-space block of the fake's synthetic field at `ramp`. */
function syntheticBlock(
  request: SimEngineRequest,
  fieldId: string,
  unit: string,
  base: number,
  amplitude: number,
  ramp: number,
): SimResultFieldBlock {
  const extent = gridExtent(request);
  const [nx, ny, nz] = extent;
  const { domainMinM, cellSizeM } = request.compiled;
  const values: number[] = [];
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        // x-fastest order (VTK ImageData order), a smooth deterministic
        // profile: sine along x, cosine along y, decay along z, step ramp.
        const profileX = 0.5 + 0.5 * Math.sin((Math.PI * (i + 0.5)) / nx);
        const profileY = 0.5 + 0.5 * Math.cos((Math.PI * (j + 0.5)) / ny);
        const profileZ = 1 / (1 + k);
        values.push(base + amplitude * profileX * profileY * profileZ * ramp);
      }
    }
  }
  return {
    id: fieldId,
    unit,
    extent,
    originMm: [
      (domainMinM[0] ?? 0) * MM_PER_M,
      (domainMinM[1] ?? 0) * MM_PER_M,
      (domainMinM[2] ?? 0) * MM_PER_M,
    ],
    spacingMm: [
      cellSizeM * MM_PER_M,
      cellSizeM * MM_PER_M,
      cellSizeM * MM_PER_M,
    ],
    dataType: "float32",
    values,
  };
}

/** The fake's solver-space scalars, projected to document quantities (S4). */
function fakeQuantities(
  request: SimEngineRequest,
): SimParseResult<readonly SimProjectedQuantity[], SimError> {
  const compiled = request.compiled;
  const speed = inletSpeedMPerS(request);
  const length = compiled.characteristicLengthM;
  const dynamicPressure = 0.5 * compiled.fluid.densityKgPerM3 * speed * speed;
  const scalars: readonly SolverSimScalar[] =
    compiled.kind === "flow"
      ? [
          {
            name: "drag-force",
            dimension: "force",
            value: dynamicPressure * length * length,
          },
          {
            name: "lift-force",
            dimension: "force",
            value: 0.5 * dynamicPressure * length * length,
          },
          {
            name: "mean-velocity",
            dimension: "velocity",
            value: speed,
          },
        ]
      : [
          {
            name: "max-temperature",
            dimension: "temperature",
            value: compiled.fluid.temperatureK + 20,
          },
          {
            name: "min-temperature",
            dimension: "temperature",
            value: compiled.fluid.temperatureK,
          },
        ];
  const projected = projectSimResult({ scalars, fields: [] });
  return projected.ok
    ? { ok: true, value: projected.value.scalars }
    : projected;
}

/** The fake's histories: deterministic sample sequences over the steps. */
function fakeHistories(
  request: SimEngineRequest,
): readonly { name: string; unit: string; samples: readonly number[] }[] {
  const compiled = request.compiled;
  const speed = inletSpeedMPerS(request);
  const final =
    compiled.kind === "flow"
      ? 0.5 *
        compiled.fluid.densityKgPerM3 *
        speed *
        speed *
        compiled.characteristicLengthM ** 2
      : compiled.fluid.temperatureK + 20;
  const samples: number[] = [];
  for (let step = 1; step <= FAKE_SIM_ENGINE_STEPS; step += 1) {
    // A monotone approach to the final value: k/n scaled with an ease.
    const fraction = step / FAKE_SIM_ENGINE_STEPS;
    samples.push(final * (1 - (1 - fraction) ** 2));
  }
  return [
    compiled.kind === "flow"
      ? { name: "drag", unit: "N", samples }
      : { name: "max-temperature", unit: "K", samples },
  ];
}

/**
 * One step's field blocks (the fields the kind publishes, at this ramp).
 * The fake authors DOCUMENT-SPACE blocks directly — values in the unit the
 * block declares — so the blocks it streams and the blocks it finalizes are
 * the same objects; the S4 scalar projection in {@link fakeQuantities}
 * exercises the solver→document door on the quantity side.
 */
function blocksAtRamp(
  request: SimEngineRequest,
  ramp: number,
): readonly SimResultFieldBlock[] {
  const compiled = request.compiled;
  const speed = inletSpeedMPerS(request);
  if (compiled.kind === "flow") {
    return [
      syntheticBlock(
        request,
        "velocity-magnitude",
        "mm/s",
        0,
        speed * MM_PER_M,
        ramp,
      ),
      syntheticBlock(
        request,
        "pressure",
        "Pa",
        0,
        0.5 * compiled.fluid.densityKgPerM3 * speed * speed,
        ramp,
      ),
    ];
  }
  return [
    syntheticBlock(
      request,
      "temperature",
      "K",
      compiled.fluid.temperatureK,
      20,
      ramp,
    ),
  ];
}

async function runFake(
  request: SimEngineRequest,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!SUPPORTED_KINDS.includes(compiled.kind)) {
    return {
      ok: false,
      error: simError(
        SIM_ERROR_CODES.scenarioKindUnsupported,
        `The fake engine does not solve the "${compiled.kind}" scenario kind (it solves flow and thermal).`,
        compiled.kind,
      ),
    };
  }
  if (compiled.backend === "gpu") {
    return {
      ok: false,
      error: simError(
        SIM_ERROR_CODES.backendUnavailable,
        'The scenario prefers the "gpu" backend; the fake engine is CPU-only, and until Phase 64\'s provider and its feature-detect fallback exist, a GPU-preferred scenario declines loudly instead of silently falling back.',
        compiled.backend,
      ),
    };
  }
  // The emission schedule: progress every step, a chunk round every
  // steps/rounds; the run's callbacks throw when the host aborts, and the
  // throw unwinds this loop (a conforming engine does not catch).
  const roundInterval = FAKE_SIM_ENGINE_STEPS / FAKE_SIM_ENGINE_CHUNK_ROUNDS;
  for (let step = 1; step <= FAKE_SIM_ENGINE_STEPS; step += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    onProgress?.({ step, totalSteps: FAKE_SIM_ENGINE_STEPS });
    if (onFieldChunk !== undefined && step % roundInterval === 0) {
      const ramp = step / FAKE_SIM_ENGINE_STEPS;
      for (const block of blocksAtRamp(request, ramp)) {
        for (const chunk of splitSimFieldBlock(
          block,
          FAKE_SIM_ENGINE_FIELD_CHUNKS,
        )) {
          onFieldChunk(chunk);
        }
      }
    }
  }
  const finalBlocks = blocksAtRamp(request, 1);
  const quantities = fakeQuantities(request);
  if (!quantities.ok) return quantities;
  const result: SimResult = {
    summary: {
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: compiled.scenarioSnapshotHash,
      status: "completed",
      regime: compiled.regime,
      quantities: quantities.value,
    },
    fields: finalBlocks,
    histories: fakeHistories(request),
  };
  return { ok: true, value: result };
}

/** The deterministic fake engine (the `fake-kernel` precedent's shape). */
export const FAKE_SIM_ENGINE: SimEngine = {
  id: FAKE_SIM_ENGINE_ID,
  supportedKinds: ["flow", "thermal"],
  backend: "cpu",
  run: (request, onProgress, onFieldChunk) =>
    runFake(request, onProgress, onFieldChunk),
};

/** Creates the deterministic fake engine (the hosting default until 63). */
export function createFakeSimEngine(): SimEngine {
  return FAKE_SIM_ENGINE;
}
