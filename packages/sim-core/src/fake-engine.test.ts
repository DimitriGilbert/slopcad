/**
 * Fake engine tests (Phase 61b): the deterministic reference — same
 * compiled scenario → identical results and identical emission schedules —
 * plus the honest declines (unsupported kind, gpu preference) and the
 * cooperative-cancellation unwinding. The `fake-kernel` suite's discipline,
 * carried to the SimEngine contract.
 */

import { describe, expect, it } from "vitest";
import type { SimEngineFieldChunk, SimEngineProgress } from "./engine";

import {
  createFakeSimEngine,
  FAKE_SIM_ENGINE_CHUNK_ROUNDS,
  FAKE_SIM_ENGINE_FIELD_CHUNKS,
  FAKE_SIM_ENGINE_ID,
  FAKE_SIM_ENGINE_STEPS,
} from "./fake-engine";
import { reassembleSimFieldChunks } from "./sim-field-chunks";
import { SIM_ERROR_CODES } from "./errors";
import { compileSimScenario, type SimCompileInput } from "./units";

function flowScenario(): Record<string, unknown> {
  return {
    id: "sim_000001",
    name: "Wind tunnel",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [-500, -250, -250],
      max: [500, 250, 250],
      resolutionMm: 2,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 10,
        direction: [1, 0, 0],
      },
      { kind: "pressure-outlet", face: "xMax", pressurePa: 0 },
    ],
    fluid: "air",
    materials: [],
  };
}

function thermalScenario(): Record<string, unknown> {
  return {
    id: "sim_000002",
    name: "Stove",
    kind: "thermal",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [200, 200, 200],
      resolutionMm: 4,
    },
    conditions: [
      {
        kind: "fixed-temperature",
        face: "xMin",
        temperatureK: 500,
      },
    ],
    fluid: "air",
    materials: [],
  };
}

function compiledOf(scenario: unknown) {
  const compiled = compileSimScenario({ scenario } satisfies SimCompileInput);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled.value;
}

async function runWithSchedule(scenario: unknown) {
  const engine = createFakeSimEngine();
  const progress: SimEngineProgress[] = [];
  const chunks: SimEngineFieldChunk[] = [];
  const result = await engine.run(
    { compiled: compiledOf(scenario) },
    (entry) => progress.push(entry),
    (chunk) => chunks.push(chunk),
  );
  return { progress, chunks, result };
}

describe("the deterministic reference", () => {
  it("emits the scheduled progress and chunk stream and finalizes a well-formed result", async () => {
    const { progress, chunks, result } = await runWithSchedule(flowScenario());
    expect(progress.length).toBe(FAKE_SIM_ENGINE_STEPS);
    expect(progress.at(-1)).toEqual({
      step: FAKE_SIM_ENGINE_STEPS,
      totalSteps: FAKE_SIM_ENGINE_STEPS,
    });
    // Two fields per round, chunk-split, for every round.
    expect(chunks.length).toBe(
      FAKE_SIM_ENGINE_CHUNK_ROUNDS * 2 * FAKE_SIM_ENGINE_FIELD_CHUNKS,
    );
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.summary.status).toBe("completed");
    expect(result.value.summary.regime.prandtl).toBeDefined();
    expect(result.value.fields.map((field) => field.id)).toEqual([
      "velocity-magnitude",
      "pressure",
    ]);
    expect(result.value.histories.length).toBe(1);
  });

  it("produces bitwise-identical results and emission schedules on repeat runs", async () => {
    const first = await runWithSchedule(flowScenario());
    const second = await runWithSchedule(flowScenario());
    expect(second.progress).toEqual(first.progress);
    expect(second.chunks).toEqual(first.chunks);
    expect(first.result.ok && second.result.ok).toBe(true);
    if (!first.result.ok || !second.result.ok) return;
    expect(second.result.value).toEqual(first.result.value);
  });

  it("streams a final chunk round that reassembles to exactly the finalized blocks", async () => {
    const { chunks, result } = await runWithSchedule(flowScenario());
    if (!result.ok) throw new Error(result.error.message);
    // The emission order interleaves the two fields per round; group by
    // field, then take each field's last chunkCount entries — the final
    // round — and demand it reassembles to the finalized block.
    const perField = new Map<string, SimEngineFieldChunk[]>();
    for (const chunk of chunks) {
      const bucket = perField.get(chunk.id) ?? [];
      bucket.push(chunk);
      perField.set(chunk.id, bucket);
    }
    expect(perField.size).toBe(result.value.fields.length);
    for (const field of result.value.fields) {
      const stream = perField.get(field.id);
      if (stream === undefined) throw new Error("field streamed no chunks");
      const finalRound = stream.slice(-FAKE_SIM_ENGINE_FIELD_CHUNKS);
      const reassembled = reassembleSimFieldChunks(finalRound);
      if (!reassembled.ok) throw new Error(reassembled.error.message);
      expect(reassembled.value).toEqual(field);
    }
  });

  it("solves the thermal kind with its own field and quantities", async () => {
    const { result } = await runWithSchedule(thermalScenario());
    if (!result.ok) throw new Error(result.error.message);
    expect(result.value.fields.map((field) => field.id)).toEqual([
      "temperature",
    ]);
    expect(result.value.summary.quantities.map((q) => q.name)).toEqual([
      "max-temperature",
      "min-temperature",
    ]);
  });

  it("declines a structural run the fake engine does not solve", async () => {
    const engine = createFakeSimEngine();
    const structural = {
      id: "sim_000003",
      name: "Bracket",
      kind: "structural",
      domain: {
        kind: "explicit" as const,
        min: [0, 0, 0] as const,
        max: [100, 100, 100] as const,
        resolutionMm: 2,
      },
      conditions: [],
      fluid: "air",
      materials: [],
    };
    // The compile boundary accepts the kind (Phase 69 is live: the
    // structural solver exists behind the same contract); the FAKE
    // engine's own kind gate still declines it — the contract's rule
    // that an engine declares only the kinds it solves.
    const compiled = compileSimScenario({ scenario: structural });
    expect(compiled.ok).toBe(true);
    const direct = await engine.run({
      compiled: {
        ...compiledOf(flowScenario()),
        kind: "structural",
      },
    });
    expect(direct.ok).toBe(false);
    if (direct.ok) return;
    expect(direct.error.code).toBe(SIM_ERROR_CODES.scenarioKindUnsupported);
  });

  it("declines a gpu-preferring scenario until Phase 64's provider exists", async () => {
    const gpuScenario = { ...flowScenario(), backend: "gpu" };
    const engine = createFakeSimEngine();
    const result = await engine.run({ compiled: compiledOf(gpuScenario) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(SIM_ERROR_CODES.backendUnavailable);
  });

  it("unwinds cooperatively when the progress callback throws (the abort sentinel)", async () => {
    const engine = createFakeSimEngine();
    const sentinel = new Error("cancelled by the host");
    const result = engine.run({ compiled: compiledOf(flowScenario()) }, () => {
      throw sentinel;
    });
    await expect(result).rejects.toBe(sentinel);
    expect(engine.id).toBe(FAKE_SIM_ENGINE_ID);
  });
});
