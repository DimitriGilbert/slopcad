/**
 * Sim worker server tests (Phase 61b): the hosted engine responder over an
 * in-memory channel — the full compile → run (notification stream) →
 * finalize round trip, the session-addressing declines, the engine-failure
 * mapping onto `worker/operation-failed` + `data.simCode`, and the pinned
 * cancellation windows observable on the microtask-delayed transport.
 */

import { describe, expect, it } from "vitest";
import type { SimEngine } from "./engine";
import type { SimWorkerMessage } from "./sim-worker-protocol";
import type {
  SimWorkerOperationId,
  SimWorkerOperationInput,
} from "./sim-worker-operations";

import { createSimInMemoryTransportPair } from "./sim-transport";
import { createSimWorkerServer } from "./sim-worker-server";
import {
  createSimWorkerRequest,
  decodeSimWorkerNotification,
  parseSimWorkerMessage,
} from "./sim-worker-protocol";
import { parseSimWorkerOperationResult } from "./sim-worker-operations";
import { SIM_WORKER_PROTOCOL_ERROR_CODES } from "./sim-worker-errors";
import { SIM_ERROR_CODES, simError } from "./errors";
import { createFakeSimEngine } from "./fake-engine";
import { type SimCompileInput, compileSimScenario } from "./units";
import {
  createSimWorkerRequestId,
  type SimProblemId,
  type SimRunId,
  parseSimProblemId,
  parseSimRunId,
} from "./sim-worker-ids";

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

/** Drives a server over the pair's client end with raw wire messages. */
function harness(engine: SimEngine = createFakeSimEngine()) {
  const pair = createSimInMemoryTransportPair();
  const server = createSimWorkerServer({ engine, transport: pair.server });
  const sent: unknown[] = [];
  pair.client.onMessage((data) => sent.push(data));
  let counter = 0;
  const request = <O extends SimWorkerOperationId>(
    operation: O,
    input: SimWorkerOperationInput<O>,
  ) => {
    counter += 1;
    const id = createSimWorkerRequestId(
      `req_t${String(counter).padStart(4, "0")}`,
    );
    pair.client.send(createSimWorkerRequest(id, operation, input));
    return id;
  };
  return { pair, server, sent, request };
}

function parseAll(sent: readonly unknown[]): SimWorkerMessage[] {
  return sent.flatMap((entry) => {
    const parsed = parseSimWorkerMessage(entry);
    return parsed.ok ? [parsed.value] : [];
  });
}

async function settle(): Promise<void> {
  // The fake run rides 24 macrotask turns; drain generously past them.
  for (let index = 0; index < 200; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("the compile → run → finalize round trip", () => {
  it("compiles, streams progress and field chunks, and finalizes the run's result", async () => {
    const { server, sent, request } = harness();
    const compileId = request("sim.compile", { scenario: flowScenario() });
    await settle();
    const messages = parseAll(sent);
    const compileResponse = messages.find(
      (message) =>
        message.kind === "response" &&
        message.requestId === compileId &&
        message.status === "ok",
    );
    expect(compileResponse).toBeDefined();
    if (
      compileResponse === undefined ||
      compileResponse.kind !== "response" ||
      compileResponse.status !== "ok"
    ) {
      return;
    }
    const compiled = compileSimScenario({
      scenario: flowScenario(),
    } satisfies SimCompileInput);
    if (!compiled.ok) throw new Error(compiled.error.message);
    // The compile response's result decodes to the minted problem id plus
    // the compiled scenario, SI regime and provenance included.
    const decoded = parseSimWorkerOperationResult(
      "sim.compile",
      compileResponse.result,
    );
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(decoded.value.problem).toBe("wprob_000001");
    expect(decoded.value.compiled.domainMinM).toEqual([-0.5, -0.25, -0.25]);
    expect(decoded.value.compiled.cellSizeM).toBeCloseTo(0.002, 12);
    expect(decoded.value.compiled.regime.prandtl).toBeDefined();
    expect(decoded.value.compiled.scenarioSnapshotHash).toBe(
      compiled.value.scenarioSnapshotHash,
    );

    const runRequestId = request("sim.run", {
      problem: problemId("wprob_000001"),
    });
    await settle();
    const runMessages = parseAll(sent);
    const progress = runMessages.filter(
      (message) =>
        message.kind === "notification" &&
        message.requestId === runRequestId &&
        message.notification.kind === "progress",
    );
    const chunks = runMessages.filter(
      (message) =>
        message.kind === "notification" &&
        message.requestId === runRequestId &&
        message.notification.kind === "field-chunk",
    );
    expect(progress.length).toBe(24);
    expect(chunks.length).toBe(24);
    // Notifications stream BEFORE the terminal response, in channel order.
    const orderIndex = (predicate: (message: unknown) => boolean): number =>
      sent.findIndex((entry) => predicate(entry));
    const isResponseFor = (entry: unknown): boolean => {
      const parsed = parseSimWorkerMessage(entry);
      return (
        parsed.ok &&
        parsed.value.kind === "response" &&
        parsed.value.requestId === runRequestId
      );
    };
    const isNotificationFor = (entry: unknown): boolean => {
      const parsed = parseSimWorkerMessage(entry);
      return (
        parsed.ok &&
        parsed.value.kind === "notification" &&
        parsed.value.requestId === runRequestId
      );
    };
    const lastNotificationIndex = Math.max(
      ...sent
        .map((_entry, index) => index)
        .filter((index) => isNotificationFor(sent[index])),
    );
    expect(lastNotificationIndex).toBeLessThan(orderIndex(isResponseFor));

    const finalizeId = request("sim.finalize", { run: runId("wrun_000001") });
    await settle();
    const finalizeResponse = parseAll(sent).find(
      (message) =>
        message.kind === "response" &&
        message.requestId === finalizeId &&
        message.status === "ok",
    );
    expect(finalizeResponse).toBeDefined();
    server.close();
  });

  it("finalizes repeatably with identical bytes", async () => {
    const { server, sent, request } = harness();
    request("sim.compile", { scenario: flowScenario() });
    await settle();
    request("sim.run", { problem: problemId("wprob_000001") });
    await settle();
    const first = request("sim.finalize", { run: runId("wrun_000001") });
    const second = request("sim.finalize", { run: runId("wrun_000001") });
    await settle();
    const results = parseAll(sent)
      .filter(
        (message) =>
          message.kind === "response" &&
          message.status === "ok" &&
          (message.requestId === first || message.requestId === second),
      )
      .map((message) => {
        if (message.kind !== "response" || message.status !== "ok") return null;
        return JSON.stringify(message.result);
      });
    expect(results.length).toBe(2);
    expect(results[0]).toBe(results[1]);
    server.close();
  });
});

describe("session addressing and engine failures", () => {
  it("declines a run on an unknown problem id with data.simCode", async () => {
    const { server, sent, request } = harness();
    request("sim.run", { problem: problemId("wprob_000404") });
    await settle();
    const failure = parseAll(sent).find(
      (message) => message.kind === "response" && message.status === "error",
    );
    expect(failure).toBeDefined();
    if (
      failure === undefined ||
      failure.kind !== "response" ||
      failure.status !== "error"
    ) {
      return;
    }
    expect(failure.error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
    );
    expect(failure.error.data?.simCode).toBe("sim/problem-unknown");
    server.close();
  });

  it("declines a finalize on an unknown run id with data.simCode", async () => {
    const { server, sent, request } = harness();
    request("sim.finalize", { run: runId("wrun_000404") });
    await settle();
    const failure = parseAll(sent).find(
      (message) => message.kind === "response" && message.status === "error",
    );
    if (
      failure === undefined ||
      failure.kind !== "response" ||
      failure.status !== "error"
    ) {
      throw new Error("the unknown-run finalize must fail");
    }
    expect(failure.error.data?.simCode).toBe("sim/run-unknown");
    server.close();
  });

  it("maps an engine decline onto worker/operation-failed with the sim code", async () => {
    // A flow-only engine asked to run a thermal problem declines through
    // the contract; the wire carries it as a structured operation failure.
    const flowOnlyEngine: SimEngine = {
      id: "flow-only-test",
      supportedKinds: ["flow"],
      backend: "cpu",
      run: (request_) => {
        void request_;
        throw new Error("unreachable: the server gates before the engine");
      },
    };
    const { server, sent, request } = harness(flowOnlyEngine);
    request("sim.compile", {
      scenario: {
        ...flowScenario(),
        kind: "thermal",
      },
    });
    await settle();
    request("sim.run", { problem: problemId("wprob_000001") });
    await settle();
    const failure = parseAll(sent).find(
      (message) => message.kind === "response" && message.status === "error",
    );
    if (
      failure === undefined ||
      failure.kind !== "response" ||
      failure.status !== "error"
    ) {
      throw new Error("the thermal run must fail");
    }
    expect(failure.error.data?.simCode).toBe("sim/scenario-kind-unsupported");
    server.close();
  });

  it("refuses a duplicate request id, whatever the first use's fate", async () => {
    const { server, sent, pair } = harness();
    const id = createSimWorkerRequestId("req_dup1");
    pair.client.send(
      createSimWorkerRequest(id, "sim.compile", { scenario: flowScenario() }),
    );
    await settle();
    pair.client.send(
      createSimWorkerRequest(id, "sim.compile", { scenario: flowScenario() }),
    );
    await settle();
    const failures = parseAll(sent).filter(
      (message) => message.kind === "response" && message.status === "error",
    );
    expect(failures.length).toBe(1);
    if (failures[0] === undefined) return;
    if (failures[0].kind !== "response" || failures[0].status !== "error") {
      return;
    }
    expect(failures[0].error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.duplicateRequest,
    );
    server.close();
  });
});

describe("cancellation at the responder", () => {
  it("acks a cancel that overtook its request, and never executes it", async () => {
    const { server, sent, pair } = harness();
    const id = createSimWorkerRequestId("req_cnl1");
    pair.client.send({
      protocolVersion: 1,
      kind: "cancel",
      requestId: id,
    });
    await settle();
    pair.client.send(
      createSimWorkerRequest(id, "sim.compile", { scenario: flowScenario() }),
    );
    await settle();
    const responses = parseAll(sent).filter(
      (message) => message.kind === "response",
    );
    expect(responses.length).toBe(1);
    if (responses[0] === undefined) return;
    if (responses[0].kind !== "response" || responses[0].status !== "error") {
      throw new Error("the overtaken request must be refused");
    }
    expect(responses[0].error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.cancelled,
    );
    server.close();
  });

  it("suppresses a run cancelled mid-flight: the ack replaces the outcome, no run minted", async () => {
    const { server, sent, request, pair } = harness();
    request("sim.compile", { scenario: flowScenario() });
    await settle();
    const runRequestId = request("sim.run", {
      problem: problemId("wprob_000001"),
    });
    // Cancel while the run rides its macrotask turns.
    await new Promise((resolve) => setTimeout(resolve, 0));
    pair.client.send({
      protocolVersion: 1,
      kind: "cancel",
      requestId: runRequestId,
    });
    await settle();
    const responses = parseAll(sent).filter(
      (message) =>
        message.kind === "response" && message.requestId === runRequestId,
    );
    expect(responses.length).toBe(1);
    if (responses[0] === undefined) return;
    if (responses[0].kind !== "response" || responses[0].status !== "error") {
      throw new Error("the cancelled run must error, never succeed");
    }
    expect(responses[0].error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.cancelled,
    );
    // Nothing finalized: no run id was minted for the suppressed outcome.
    const finalizeId = createSimWorkerRequestId("req_cnl1_f");
    pair.client.send(
      createSimWorkerRequest(finalizeId, "sim.finalize", {
        run: runId("wrun_000001"),
      }),
    );
    await settle();
    const finalizeResponse = parseAll(sent).find(
      (message) =>
        message.kind === "response" && message.requestId === finalizeId,
    );
    if (
      finalizeResponse === undefined ||
      finalizeResponse.kind !== "response" ||
      finalizeResponse.status !== "error"
    ) {
      throw new Error("finalizing a cancelled run must decline");
    }
    expect(finalizeResponse.error.data?.simCode).toBe("sim/run-unknown");
    server.close();
  });
});

describe("the parse boundary", () => {
  it("answers an unparseable message with a null-correlated error", async () => {
    const { server, sent, pair } = harness();
    pair.client.send({ protocolVersion: 2, kind: "request" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.length).toBe(1);
    const parsed = parseSimWorkerMessage(sent[0]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.kind).toBe("response");
    if (parsed.value.kind !== "response") return;
    expect(parsed.value.requestId).toBeNull();
    server.close();
  });

  it("drops misdirected responses and notifications in the responder role", async () => {
    const { server, sent, pair } = harness();
    pair.client.send({
      protocolVersion: 1,
      kind: "notification",
      requestId: "req_000001",
      notification: { kind: "progress", step: 1 },
    });
    pair.client.send({
      protocolVersion: 1,
      kind: "response",
      requestId: "req_000001",
      status: "ok",
      result: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent.length).toBe(0);
    server.close();
  });
});

describe("the optimization executor seam (Phase 70a)", () => {
  const optimizeInput = {
    study: { id: "study_x", name: "x" },
    scenario: flowScenario(),
    parameters: { parameters: [] },
  };

  const stubResult = {
    campaign: "abcd1234",
    generations: [
      {
        generation: 0,
        evaluations: 2,
        candidates: [
          {
            index: 0,
            genomeParameters: [{ parameterId: "param_width", value: 5 }],
            genomeRecords: [],
            status: "ok" as const,
            objectives: [1],
            rank: 0,
          },
        ],
      },
    ],
    evaluations: 2,
    declined: 0,
    pareto: [
      {
        index: 0,
        genomeParameters: [{ parameterId: "param_width", value: 5 }],
        genomeRecords: [],
        status: "ok" as const,
        objectives: [1],
        rank: 0,
      },
    ],
  };

  it("declines sim.optimize loudly when no executor is hosted", async () => {
    const { sent, request } = harness();
    request("sim.optimize", optimizeInput);
    await settle();
    const responses = parseAll(sent).filter(
      (message) => message.kind === "response",
    );
    const failure = responses[0];
    expect(failure?.kind === "response" && failure.status === "error").toBe(
      true,
    );
    if (
      failure === undefined ||
      failure.kind !== "response" ||
      failure.status !== "error"
    ) {
      return;
    }
    expect(failure.error.code).toBe(
      SIM_WORKER_PROTOCOL_ERROR_CODES.operationFailed,
    );
    expect(failure.error.data).toMatchObject({
      simCode: "sim/optimizer-unavailable",
    });
  });

  it("executes through an injected executor and streams both notice kinds", async () => {
    const pair = createSimInMemoryTransportPair();
    const notices: string[] = [];
    const sent: unknown[] = [];
    const server = createSimWorkerServer({
      engine: createFakeSimEngine(),
      transport: pair.server,
      optimizer: (input, callbacks) => {
        expect(input.study).toEqual(optimizeInput.study);
        callbacks.onProgress({ step: 1, totalSteps: 4 });
        callbacks.onOptimizationGeneration({
          generation: 0,
          evaluated: 2,
          budget: 4,
          best: [1],
        });
        return Promise.resolve({ ok: true, value: stubResult });
      },
    });
    void server;
    pair.client.onMessage((data) => {
      sent.push(data);
      const parsed = parseSimWorkerMessage(data);
      if (!parsed.ok) return;
      if (parsed.value.kind !== "notification") return;
      const decoded = decodeSimWorkerNotification(parsed.value);
      if (!decoded.ok) return;
      notices.push(decoded.value.notification.kind);
    });
    pair.client.send(
      createSimWorkerRequest(
        createSimWorkerRequestId("req_opt1"),
        "sim.optimize",
        optimizeInput,
      ),
    );
    await settle();
    expect(notices).toEqual(["progress", "optimization-generation"]);
    const response = parseAll(sent).find(
      (message) => message.kind === "response",
    );
    if (
      response === undefined ||
      response.kind !== "response" ||
      response.status !== "ok"
    ) {
      throw new Error("expected a success response");
    }
    const parsedResult = parseSimWorkerOperationResult(
      "sim.optimize",
      response.result,
    );
    expect(parsedResult.ok).toBe(true);
    if (parsedResult.ok) {
      expect(parsedResult.value.campaign).toBe("abcd1234");
    }
  });

  it("maps an executor decline onto worker/operation-failed with the sim code", async () => {
    const pair = createSimInMemoryTransportPair();
    const sent: unknown[] = [];
    pair.client.onMessage((data) => sent.push(data));
    createSimWorkerServer({
      engine: createFakeSimEngine(),
      transport: pair.server,
      optimizer: () =>
        Promise.resolve({
          ok: false,
          error: simError(SIM_ERROR_CODES.studyInvalid, "bad study", null),
        }),
    });
    pair.client.send(
      createSimWorkerRequest(
        createSimWorkerRequestId("req_opt2"),
        "sim.optimize",
        optimizeInput,
      ),
    );
    await settle();
    const failure = parseAll(sent).find(
      (message) => message.kind === "response",
    );
    if (
      failure === undefined ||
      failure.kind !== "response" ||
      failure.status !== "error"
    ) {
      throw new Error("expected an error response");
    }
    expect(failure.error.data).toMatchObject({ simCode: "sim/study-invalid" });
  });
});
