/**
 * Operation vocabulary tests (Phase 61b): the `sim.*` codecs' round trips
 * (typed → wire → JSON → wire → typed) and their structured declines —
 * the kernel operations suite's discipline for the sim table.
 */

import { describe, expect, it } from "vitest";
import type { SimProblemId, SimRunId } from "./sim-worker-ids";

import {
  isSimWorkerOperationId,
  parseSimWorkerOperationInput,
  parseSimWorkerOperationResult,
  serializeSimWorkerOperationInput,
  serializeSimWorkerOperationResult,
  SIM_WORKER_OPERATION_IDS,
  simResultToFinalizeResult,
} from "./sim-worker-operations";
import { compileSimScenario, type SimCompileInput } from "./units";
import { encodeSimResultPayload } from "./sim-result";
import { parseSimProblemId, parseSimRunId } from "./sim-worker-ids";
import { SIM_WORKER_PROTOCOL_ERROR_CODES } from "./sim-worker-errors";

function problemId(raw: string): SimProblemId {
  const parsed = parseSimProblemId(raw);
  if (!parsed.ok) throw new Error("test problem id must parse");
  return parsed.value;
}

function runId(raw: string): SimRunId {
  const parsed = parseSimRunId(raw);
  if (!parsed.ok) throw new Error("test run id must parse");
  return parsed.value;
}

/** A serialized flow scenario over an explicit 1000×500×500 mm domain. */
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
    gravityMPerS2: [0, -9.80665, 0],
  };
}

function compiledOf(scenario: unknown) {
  const compiled = compileSimScenario({ scenario } satisfies SimCompileInput);
  if (!compiled.ok) throw new Error(compiled.error.message);
  return compiled.value;
}

function expectPayloadFailure(parsed: {
  ok: boolean;
  error?: { code: string };
}): void {
  expect(parsed.ok).toBe(false);
  if (parsed.ok) return;
  expect(parsed.error?.code).toBe(
    SIM_WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
  );
}

describe("the operation registry", () => {
  it("knows exactly the sim.* vocabulary", () => {
    expect(SIM_WORKER_OPERATION_IDS).toEqual([
      "sim.compile",
      "sim.run",
      "sim.finalize",
    ]);
    expect(isSimWorkerOperationId("sim.run")).toBe(true);
    expect(isSimWorkerOperationId("solid.createBox")).toBe(false);
  });
});

describe("sim.compile codecs", () => {
  it("round-trips the input through its canonical wire form", () => {
    const input = {
      scenario: flowScenario(),
      bodyBounds: [
        {
          bodyId: "body_000001",
          minMm: [-10, -10, -10] as const,
          maxMm: [10, 10, 10] as const,
        },
      ],
    };
    const wire = serializeSimWorkerOperationInput("sim.compile", input);
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    const parsed = parseSimWorkerOperationInput(
      "sim.compile",
      JSON.parse(JSON.stringify(wire)),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.scenario).toEqual(input.scenario);
    expect(parsed.value.bodyBounds).toEqual(input.bodyBounds);
  });

  it("demands a scenario field and validates body bound structure", () => {
    expectPayloadFailure(parseSimWorkerOperationInput("sim.compile", {}));
    expectPayloadFailure(
      parseSimWorkerOperationInput("sim.compile", {
        scenario: {},
        bodyBounds: [
          { bodyId: "body_000001", minMm: [0, 0], maxMm: [1, 1, 1] },
        ],
      }),
    );
  });

  it("round-trips the mechanism wire (Phase 67c) across the codec", () => {
    const mechanism = {
      occurrences: [
        {
          id: "occ_base",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      ],
      joints: [
        {
          id: "jnt_crank",
          name: "Crank main bearing",
          kind: "revolute",
          baseOccurrenceId: "occ_base",
          occurrenceId: "occ_crank",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        },
      ],
      masses: [
        {
          occurrenceId: "occ_base",
          massGrams: 282.6,
          centerOfGravityMm: [65, 0, 0],
        },
      ],
      grounded: ["occ_base"],
    };
    const wire = serializeSimWorkerOperationInput("sim.compile", {
      scenario: flowScenario(),
      mechanism,
    });
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    const parsed = parseSimWorkerOperationInput(
      "sim.compile",
      JSON.parse(JSON.stringify(wire)),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mechanism).toEqual(mechanism);
  });

  it("declines malformed mechanism wires loudly, never filtering them", () => {
    const overMechanism = (mechanism: unknown) =>
      parseSimWorkerOperationInput("sim.compile", {
        scenario: flowScenario(),
        mechanism,
      });
    expectPayloadFailure(overMechanism("not a record"));
    expectPayloadFailure(overMechanism({ occurrences: [], masses: [] }));
    // The never-guess posture (Phase 67c validator finding): a
    // non-string grounded entry is declined, never silently dropped
    // from the weld list.
    expectPayloadFailure(
      overMechanism({
        occurrences: [{ id: "occ_base" }],
        joints: [],
        masses: [],
        grounded: ["occ_base", 42],
      }),
    );
    expectPayloadFailure(
      overMechanism({
        occurrences: [{ id: "occ_base" }],
        joints: [],
        masses: [],
        grounded: "occ_base",
      }),
    );
  });

  it("round-trips the compiled scenario with its regime and provenance", () => {
    const compiled = compiledOf(flowScenario());
    const result = {
      problem: problemId("wprob_000001"),
      compiled,
    };
    const wire = serializeSimWorkerOperationResult("sim.compile", result);
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    const parsed = parseSimWorkerOperationResult(
      "sim.compile",
      JSON.parse(JSON.stringify(wire)),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.problem).toBe("wprob_000001");
    expect(parsed.value.compiled).toEqual(compiled);
  });

  it("declines a compiled scenario whose regime flags lie", () => {
    const compiled = compiledOf(flowScenario());
    const wire = serializeSimWorkerOperationResult("sim.compile", {
      problem: problemId("wprob_000001"),
      compiled,
    });
    const tampered = {
      ...wire,
      compiled: {
        ...wire.compiled,
        regime: { qualitative: ["made-up-flag"] },
      },
    };
    expectPayloadFailure(
      parseSimWorkerOperationResult("sim.compile", tampered),
    );
  });
});

describe("sim.run codecs", () => {
  it("round-trips input and result", () => {
    const inputWire = serializeSimWorkerOperationInput("sim.run", {
      problem: problemId("wprob_000003"),
    });
    expect(inputWire).toEqual({ problem: "wprob_000003" });
    const parsedInput = parseSimWorkerOperationInput("sim.run", inputWire);
    expect(parsedInput.ok && parsedInput.value.problem).toBe("wprob_000003");
    const resultWire = serializeSimWorkerOperationResult("sim.run", {
      run: runId("wrun_000002"),
      steps: 24,
      chunks: 24,
    });
    const parsedResult = parseSimWorkerOperationResult("sim.run", resultWire);
    expect(parsedResult.ok && parsedResult.value).toEqual({
      run: "wrun_000002",
      steps: 24,
      chunks: 24,
    });
  });

  it("declines a result with negative or fractional counts", () => {
    expectPayloadFailure(
      parseSimWorkerOperationResult("sim.run", {
        run: "wrun_000002",
        steps: -1,
        chunks: 0,
      }),
    );
    expectPayloadFailure(
      parseSimWorkerOperationResult("sim.run", {
        run: "wrun_000002",
        steps: 1.5,
        chunks: 0,
      }),
    );
  });
});

describe("sim.finalize codecs", () => {
  it("carries the result as the deterministic SMR1 payload bytes", () => {
    const result = {
      summary: {
        schemaVersion: 1,
        scenarioSnapshotHash: "abc123",
        status: "completed" as const,
        regime: { qualitative: [] as const },
        quantities: [] as const,
      },
      fields: [
        {
          id: "pressure",
          unit: "Pa",
          extent: [2, 2, 1] as const,
          originMm: [0, 0, 0] as const,
          spacingMm: [1, 1, 1] as const,
          dataType: "float32" as const,
          values: [1, 2, 3, 4],
        },
      ],
      histories: [
        { name: "drag", unit: "N", samples: [1, 2, 3] as const },
      ] as const,
    };
    const finalize = simResultToFinalizeResult(result);
    expect(finalize.ok).toBe(true);
    if (!finalize.ok) return;
    const wire = serializeSimWorkerOperationResult(
      "sim.finalize",
      finalize.value,
    );
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    const parsed = parseSimWorkerOperationResult(
      "sim.finalize",
      JSON.parse(JSON.stringify(wire)),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // The payload bytes the wire carried are the exact SMR1 encoding of the
    // result's blocks — lossless, byte for byte.
    const expected = encodeSimResultPayload(result.fields);
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(parsed.value.payload).toEqual(expected.value);
    expect(parsed.value.summary).toEqual(result.summary);
    expect(parsed.value.histories).toEqual(result.histories);
  });

  it("declines a payload that is not strict base64 or not an SMR1 set", () => {
    expectPayloadFailure(
      parseSimWorkerOperationResult("sim.finalize", {
        summary: { schemaVersion: 1 },
        payload: "not base64!!",
        histories: [],
      }),
    );
    expectPayloadFailure(
      parseSimWorkerOperationResult("sim.finalize", {
        summary: { schemaVersion: 1 },
        payload: "AAAA",
        histories: [],
      }),
    );
  });
});
