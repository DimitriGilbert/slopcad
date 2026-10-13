/**
 * Sim worker boot tests (Phase 61b): the crash-settling boot over a fake
 * port — the kernel `worker-boot` suite's triggers (error, messageerror,
 * the worker-side boot-failure report, deliberate dispose) for the sim
 * channel, plus the boot-failure report parser's own tolerance. The
 * load-bearing rule mirrors the kernel's: a request pending when the
 * channel dies SETTLES (with the structured `worker/transport-closed`
 * failure) instead of hanging forever.
 */

import { describe, expect, it } from "vitest";

import {
  bootSimWorkerChannel,
  type SimWorkerBootFailure,
  type SimWorkerCrashPort,
} from "./sim-worker-boot";
import {
  parseSimWorkerBootFailureReport,
  SIM_WORKER_BOOT_FAILURE_KEY,
} from "./sim-boot-failure-report";
import {
  createSimProgressNotification,
  createSimWorkerSuccessResponse,
} from "./sim-worker-protocol";
import {
  createSimWorkerRequestId,
  type SimRunId,
  parseSimProblemId,
  parseSimRunId,
} from "./sim-worker-ids";

function problemId(raw: string) {
  const parsed = parseSimProblemId(raw);
  if (!parsed.ok) throw new Error("test problem id must parse");
  return parsed.value;
}

function runId(raw: string): SimRunId {
  const parsed = parseSimRunId(raw);
  if (!parsed.ok) throw new Error("test run id must parse");
  return parsed.value;
}

/** The fake main-thread end of a dedicated sim worker channel. */
class FakeSimWorkerPort implements SimWorkerCrashPort {
  terminated = false;
  private readonly messageListeners = new Set<
    (event: { readonly data: unknown }) => void
  >();
  private readonly errorListeners = new Set<
    (event: { readonly message: string }) => void
  >();
  private readonly messageErrorListeners = new Set<() => void>();

  postMessage(): void {
    // The fake responder never runs; requests stay pending until settled.
  }

  removeEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void {
    if (type === "message") this.messageListeners.delete(listener);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(
    type: "message" | "error" | "messageerror",
    listener: (event: never) => void,
  ): void {
    if (type === "message") {
      this.messageListeners.add(
        listener as (event: { readonly data: unknown }) => void,
      );
    } else if (type === "error") {
      this.errorListeners.add(
        listener as (event: { readonly message: string }) => void,
      );
    } else {
      this.messageErrorListeners.add(listener as () => void);
    }
  }

  /** Stages the thread's `error` event (an uncaught crash). */
  crash(message: string): void {
    for (const listener of [...this.errorListeners]) listener({ message });
  }

  /** Stages the thread's `messageerror` event. */
  messageError(): void {
    for (const listener of [...this.messageErrorListeners]) listener();
  }

  /** Stages an arbitrary message arriving from the worker thread. */
  emit(data: unknown): void {
    for (const listener of [...this.messageListeners]) listener({ data });
  }
}

describe("terminal settlement", () => {
  it("settles a pending request and terminates on the worker's boot-failure report, reported once", async () => {
    const port = new FakeSimWorkerPort();
    const crashes: SimWorkerBootFailure[] = [];
    const boot = bootSimWorkerChannel(port, (failure) => crashes.push(failure));
    const pending = boot.client.request("sim.run", {
      problem: problemId("wprob_000001"),
    });
    port.emit({
      [SIM_WORKER_BOOT_FAILURE_KEY]: "hosting the sim engine failed",
    });
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    expect(crashes).toEqual([
      { kind: "boot-failure", message: "hosting the sim engine failed" },
    ]);
    expect(port.terminated).toBe(true);
    // Terminal exactly once: a later error event is a no-op.
    port.crash("late");
    expect(crashes.length).toBe(1);
    boot.dispose();
  });

  it("settles on the error event, with the empty-message honesty", async () => {
    const port = new FakeSimWorkerPort();
    const crashes: SimWorkerBootFailure[] = [];
    const boot = bootSimWorkerChannel(port, (failure) => crashes.push(failure));
    const pending = boot.client.request("sim.run", {
      problem: problemId("wprob_000001"),
    });
    port.crash("");
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(crashes.length).toBe(1);
    if (crashes[0] === undefined) return;
    expect(crashes[0].kind).toBe("error");
    expect(crashes[0].message).toContain("no error message was provided");
    boot.dispose();
  });

  it("settles on messageerror with its own fixed text", () => {
    const port = new FakeSimWorkerPort();
    const crashes: SimWorkerBootFailure[] = [];
    const boot = bootSimWorkerChannel(port, (failure) => crashes.push(failure));
    port.messageError();
    expect(crashes.length).toBe(1);
    const failure = crashes[0];
    if (failure === undefined) return;
    expect(failure.kind).toBe("messageerror");
    expect(failure.message.length).toBeGreaterThan(0);
    boot.dispose();
  });

  it("dispose settles without a crash report, and is idempotent", () => {
    const port = new FakeSimWorkerPort();
    const crashes: SimWorkerBootFailure[] = [];
    const boot = bootSimWorkerChannel(port, (failure) => crashes.push(failure));
    boot.dispose();
    boot.dispose();
    expect(crashes).toEqual([]);
    expect(port.terminated).toBe(true);
  });

  it("passes protocol traffic through: notifications reach the client while it lives", () => {
    const port = new FakeSimWorkerPort();
    const crashes: SimWorkerBootFailure[] = [];
    const boot = bootSimWorkerChannel(port, (failure) => crashes.push(failure));
    const requestId = createSimWorkerRequestId("req_000001");
    const received: number[] = [];
    boot.client.onNotification((delivery) => {
      if (delivery.notification.kind === "progress") {
        received.push(delivery.notification.step);
      }
    });
    const runPromise = boot.client.request(
      "sim.run",
      { problem: problemId("wprob_000001") },
      requestId,
    );
    port.emit(createSimProgressNotification(requestId, { step: 5 }));
    port.emit(
      createSimWorkerSuccessResponse(requestId, "sim.run", {
        run: runId("wrun_000001"),
        steps: 5,
        chunks: 0,
      }),
    );
    expect(received).toEqual([5]);
    expect(crashes).toEqual([]);
    // Handled: the staged success settles the pending run.
    void runPromise.then(
      () => undefined,
      () => undefined,
    );
    boot.dispose();
  });
});

describe("the boot-failure report parser", () => {
  it("reads only its own key, and only an honest non-empty string", () => {
    expect(
      parseSimWorkerBootFailureReport({
        [SIM_WORKER_BOOT_FAILURE_KEY]: "the failure text",
      }),
    ).toEqual({ message: "the failure text" });
    expect(parseSimWorkerBootFailureReport({ unrelated: "x" })).toBeNull();
    expect(
      parseSimWorkerBootFailureReport({ [SIM_WORKER_BOOT_FAILURE_KEY]: "" }),
    ).toBeNull();
    expect(
      parseSimWorkerBootFailureReport({ [SIM_WORKER_BOOT_FAILURE_KEY]: 7 }),
    ).toBeNull();
    expect(parseSimWorkerBootFailureReport("boot failed")).toBeNull();
  });
});
