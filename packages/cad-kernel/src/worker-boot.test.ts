/**
 * The crash-settling worker boot (Phase 35 hardening), driven against a
 * FAKE port (the `worker-web-transport` testing pattern): the boot's
 * structural `WorkerCrashPort` means no real thread is needed to stage
 * every terminal case deterministically — a request left pending, the
 * thread's `error`/`messageerror` event, the worker's own boot-failure
 * report, a deliberate `dispose()`.
 *
 * The load-bearing rule: a request pending when the channel dies SETTLES
 * (with the structured `worker/transport-closed` failure) instead of
 * hanging forever — every assertion below is bounded by the test timeout,
 * so a regression to the old never-settling behavior fails loudly.
 */

import { length } from "@slopcad/cad-core";
import { describe, expect, it } from "vitest";

import { WORKER_BOOT_FAILURE_KEY } from "./worker-boot-failure-report";
import {
  bootWorkerChannel,
  type WorkerBootFailure,
  type WorkerCrashPort,
} from "./worker-boot";

const mm = (value: number) => length(value, "mm");

const boxInput = { width: mm(2), depth: mm(3), height: mm(4) };

/** The fake main-thread end of a dedicated worker channel. */
class FakeWorkerPort implements WorkerCrashPort {
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

  /** Stages the worker entry's own boot-failure report (its death note). */
  bootFailure(message: string): void {
    this.emit({ [WORKER_BOOT_FAILURE_KEY]: message });
  }
}

interface BootHarness {
  readonly port: FakeWorkerPort;
  readonly crashes: WorkerBootFailure[];
  /** Issues one request the fake responder never answers. */
  pendingRequest(): Promise<unknown>;
  dispose(): void;
}

function setup(): BootHarness {
  const port = new FakeWorkerPort();
  const crashes: WorkerBootFailure[] = [];
  const boot = bootWorkerChannel(port, (failure) => crashes.push(failure));
  return {
    port,
    crashes,
    pendingRequest: () => boot.client.request("solid.createBox", boxInput),
    dispose: () => boot.dispose(),
  };
}

describe("the crash-settling worker boot", () => {
  it("settles a pending request with worker/transport-closed when the thread errors", async () => {
    const harness = setup();
    const pending = harness.pendingRequest();
    harness.port.crash("Uncaught SyntaxError: the entry failed to parse");
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    expect(harness.port.terminated).toBe(true);
    expect(harness.crashes).toEqual([
      {
        kind: "error",
        message: "Uncaught SyntaxError: the entry failed to parse",
      },
    ]);
  });

  it("settles a pending request with worker/transport-closed on messageerror", async () => {
    const harness = setup();
    const pending = harness.pendingRequest();
    harness.port.messageError();
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    expect(harness.port.terminated).toBe(true);
    expect(harness.crashes).toHaveLength(1);
    const crash = harness.crashes[0];
    if (crash === undefined) throw new Error("the crash report is missing.");
    expect(crash.kind).toBe("messageerror");
    expect(
      typeof crash.message === "string" && crash.message.length > 0,
      "the messageerror report carries honest text",
    ).toBe(true);
  });

  it("reports a crash even with no request in flight (the surface learns the channel died)", () => {
    const harness = setup();
    harness.port.crash("the WASM boot failed");
    expect(harness.crashes).toEqual([
      { kind: "error", message: "the WASM boot failed" },
    ]);
    expect(harness.port.terminated).toBe(true);
  });

  it("settles a pending request with worker/transport-closed when the worker reports a boot failure", async () => {
    const harness = setup();
    const pending = harness.pendingRequest();
    harness.port.bootFailure(
      "hosting the OpenCascade kernel failed: out of memory",
    );
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    expect(harness.port.terminated).toBe(true);
    expect(harness.crashes).toEqual([
      {
        kind: "boot-failure",
        message: "hosting the OpenCascade kernel failed: out of memory",
      },
    ]);
  });

  it("reports a worker boot failure even with no request in flight", () => {
    const harness = setup();
    harness.port.bootFailure("hosting the Manifold kernel failed: bad wasm");
    expect(harness.crashes).toEqual([
      {
        kind: "boot-failure",
        message: "hosting the Manifold kernel failed: bad wasm",
      },
    ]);
    expect(harness.port.terminated).toBe(true);
  });

  it("plain non-protocol traffic never settles the channel; only the boot-failure report does", async () => {
    const harness = setup();
    const pending = harness.pendingRequest();
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    // Success-shaped boot reports and arbitrary uncorrelatable data are
    // dropped by the channel — they must not settle (or terminate) it.
    harness.port.emit({
      slopcadManifoldWorkerBootMs: 42,
      slopcadManifoldWorkerWasmUrl: "a.wasm",
    });
    harness.port.emit({ requestId: "1", operation: "solid.createBox" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(settled).toBe(false);
    expect(harness.crashes).toEqual([]);
    expect(harness.port.terminated).toBe(false);
    // The report itself settles exactly the requests that were hanging.
    harness.port.bootFailure("hosting the Manifold kernel failed: link error");
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
  });

  it("a boot-failure-settled channel refuses later requests locally, and a fresh boot settles on its own failure too", async () => {
    const harness = setup();
    harness.port.bootFailure("the WASM boot failed");
    // Requests issued after the settlement are refused locally — never
    // pending — which is what lets the hosting surface's next exchange
    // fail fast instead of hanging while it re-boots a fresh worker.
    await expect(harness.pendingRequest()).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    const fresh = setup();
    const freshPending = fresh.pendingRequest();
    fresh.port.bootFailure("the re-boot failed too");
    await expect(freshPending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    expect(fresh.crashes).toEqual([
      { kind: "boot-failure", message: "the re-boot failed too" },
    ]);
  });

  it("settles terminally exactly once: a second crash event is silent", async () => {
    const harness = setup();
    const pending = harness.pendingRequest();
    harness.port.crash("first crash");
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    harness.port.crash("second crash");
    harness.port.messageError();
    harness.port.bootFailure("a late boot-failure report");
    expect(harness.crashes).toHaveLength(1);
  });

  it("dispose settles pending requests without reporting a crash, and stays idempotent", async () => {
    const harness = setup();
    const pending = harness.pendingRequest();
    harness.dispose();
    harness.dispose();
    await expect(pending).rejects.toMatchObject({
      error: { code: "worker/transport-closed" },
    });
    expect(harness.port.terminated).toBe(true);
    expect(harness.crashes).toEqual([]);
    // A crash event after a deliberate dispose reports nothing: the
    // channel is already settled and the thread is already gone.
    harness.port.crash("late crash");
    expect(harness.crashes).toEqual([]);
  });
});
