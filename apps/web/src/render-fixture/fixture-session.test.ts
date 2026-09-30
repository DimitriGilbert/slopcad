/**
 * The render fixture session's error-surface reset (review fix 08 F2): a
 * failed dispatch must not leave `data-error`/`#render-error` write-once —
 * the NEXT dispatch clears the error text synchronously (before any
 * settlement), and the status text derives "failed" only while the error
 * stands and nothing is in flight, mirroring the chain sibling's
 * discipline. Mutating the reset away (reverting `errorText = ""` at the
 * top of the dispatch form) turns the synchronous mid-dispatch assertions
 * red; mutating the status derivation turns the "failed"/"idle" pins red.
 *
 * The kernel boot and coordinator are mocked with controllable update
 * promises and a captured crash callback: the Worker construction and the
 * coordinator's request traffic are plumbing, while the surface
 * bookkeeping under test is the session's own synchronous state machine.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type * as KernelModule from "@slopcad/cad-kernel";
import type { DocumentBodySceneRequest } from "../cad-workbench/document-scene";
import type { SceneDispatchOutcome } from "./fixture-session";
import type {
  BootedWorkerChannel,
  ComputationOutcome,
  StaleResultCoordinator,
  WorkerBootFailure,
  WorkerClient,
  WorkerCrashPort,
  WorkerTransport,
} from "@slopcad/cad-kernel";

const controller = vi.hoisted(() => {
  const pending: {
    settleApplied(result?: unknown): void;
    failWith(failure: unknown): void;
  }[] = [];
  const crashCallbacks: Array<(failure: WorkerBootFailure) => void> = [];
  return {
    pending,
    crashCallbacks,
    reset(): void {
      pending.length = 0;
      crashCallbacks.length = 0;
    },
    /** Fires the booted channel's crash callback (the boot's own report). */
    crash(message: string): void {
      const fire = crashCallbacks[0];
      if (fire === undefined) {
        throw new Error("no booted channel to crash");
      }
      fire({ kind: "error", message });
    },
  };
});

vi.mock("@slopcad/cad-kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof KernelModule>();
  const revision = actual.createRevisionTag(1);
  const client: WorkerClient = {
    // Never called: the coordinator below is the fake the session talks to.
    request: () => new Promise(() => {}),
    cancel: () => {},
    close: () => {},
  };
  const boot: BootedWorkerChannel = {
    worker: {
      postMessage: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      terminate: () => {},
    } satisfies WorkerCrashPort,
    transport: {
      send: () => {},
      onMessage: () => () => {},
    } satisfies WorkerTransport,
    client,
    dispose: () => {},
  };
  const coordinator: StaleResultCoordinator<unknown> = {
    currentRevision: () => revision,
    update: () =>
      new Promise<ComputationOutcome<unknown>>((resolve, reject) => {
        controller.pending.push({
          settleApplied: (result?: unknown) =>
            resolve({ outcome: "applied", revision, result }),
          failWith: reject,
        });
      }),
    // The visible state stays empty: `settle()` then exercises exactly the
    // surface bookkeeping (counters, status, error text) under test.
    visible: () => null,
    drops: () => [],
    disposalFailures: () => [],
  };
  return {
    ...actual,
    bootWorkerChannel: (
      _port: WorkerCrashPort,
      onCrash: (failure: WorkerBootFailure) => void,
    ): BootedWorkerChannel => {
      controller.crashCallbacks.push(onCrash);
      return boot;
    },
    createStaleResultCoordinator: () => coordinator,
  };
});

import { bootRenderFixtureSession } from "./fixture-session";

const ROOT_ID = "fixture-session-test-root";
const STATUS_ID = "fixture-session-test-status";
const VOLUME_ID = "fixture-session-test-volume";
const ERROR_ID = "fixture-session-test-error";

function mountSurface(): HTMLElement {
  const root = document.createElement("div");
  root.id = ROOT_ID;
  root.innerHTML =
    `<span id="${STATUS_ID}"></span>` +
    `<span id="${VOLUME_ID}"></span>` +
    `<span id="${ERROR_ID}"></span>`;
  document.body.appendChild(root);
  return root;
}

function textOf(id: string): string {
  return document.getElementById(id)?.textContent ?? "";
}

/** Drains the microtask queue enough for `.then` settlement handlers. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  document.getElementById(ROOT_ID)?.remove();
  controller.reset();
  vi.unstubAllGlobals();
});

describe("bootRenderFixtureSession error-surface reset", () => {
  it("a failed dispatch surfaces the failure, and the next dispatch resets the error surface synchronously", async () => {
    // The session constructs a real `new Worker(...)` before the (mocked)
    // boot wraps it; jsdom has no Worker, so the constructor is stubbed —
    // the fake port above never receives traffic.
    vi.stubGlobal(
      "Worker",
      class {
        addEventListener(): void {}
        removeEventListener(): void {}
        postMessage(): void {}
        terminate(): void {}
      },
    );
    const root = mountSurface();
    const session = bootRenderFixtureSession(
      {
        rootId: ROOT_ID,
        statusId: STATUS_ID,
        volumeId: VOLUME_ID,
        errorId: ERROR_ID,
      },
      () => {},
    );

    // First dispatch FAILS: the failure's text lands on both error
    // surfaces and the status derives "failed" once nothing is in flight.
    session.dispatch(10);
    const failed = controller.pending[0];
    if (failed === undefined) {
      throw new Error("the dispatch never registered a controllable update");
    }
    failed.failWith(new Error("kernel rejected the plate"));
    await flushMicrotasks();
    expect(root.getAttribute("data-error")).toBe("kernel rejected the plate");
    expect(textOf(ERROR_ID)).toBe("kernel rejected the plate");
    expect(textOf(STATUS_ID)).toBe("failed");
    expect(root.getAttribute("data-in-flight")).toBe("0");

    // Second dispatch: the error surface resets SYNCHRONOUSLY at dispatch
    // time — before any settlement — and the status is "computing" while
    // the dispatch is in flight (not write-once, not stuck "failed").
    session.dispatch(11);
    expect(root.getAttribute("data-error")).toBe("");
    expect(textOf(ERROR_ID)).toBe("");
    expect(textOf(STATUS_ID)).toBe("computing");
    expect(root.getAttribute("data-in-flight")).toBe("1");

    // Its success settles the dispatch: status returns to "idle" and the
    // error surfaces stay clear.
    const recovered = controller.pending[1];
    if (recovered === undefined) {
      throw new Error(
        "the recovery dispatch never registered a controllable update",
      );
    }
    recovered.settleApplied();
    await flushMicrotasks();
    expect(textOf(STATUS_ID)).toBe("idle");
    expect(root.getAttribute("data-error")).toBe("");
    expect(root.getAttribute("data-in-flight")).toBe("0");
    expect(root.getAttribute("data-dispatched")).toBe("2");
    expect(root.getAttribute("data-settled")).toBe("2");

    session.dispose();
  });

  it("a crashed channel shows failed status until the next dispatch resets the surface", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        addEventListener(): void {}
        removeEventListener(): void {}
        postMessage(): void {}
        terminate(): void {}
      },
    );
    const root = mountSurface();
    const session = bootRenderFixtureSession(
      {
        rootId: ROOT_ID,
        statusId: STATUS_ID,
        errorId: ERROR_ID,
      },
      () => {},
    );

    // The boot's crash report lands on the same surface, and the status
    // derivation reports "failed" while the error stands with nothing in
    // flight (the pre-fix surface said "idle" here).
    controller.crash("the worker entry failed to load");
    expect(root.getAttribute("data-error")).toBe(
      "worker channel failed (error): the worker entry failed to load",
    );
    expect(textOf(STATUS_ID)).toBe("failed");
    expect(root.getAttribute("data-in-flight")).toBe("0");

    // The recovery path is the same discipline: the next dispatch clears
    // the crash text synchronously (its failure — if any — replaces it).
    session.dispatch(10);
    expect(root.getAttribute("data-error")).toBe("");
    expect(textOf(STATUS_ID)).toBe("computing");
    const postCrash = controller.pending[0];
    if (postCrash === undefined) {
      throw new Error("the post-crash dispatch registered no update");
    }
    postCrash.failWith(new Error("late refusal"));
    await flushMicrotasks();
    expect(root.getAttribute("data-error")).toBe("late refusal");
    expect(textOf(STATUS_ID)).toBe("failed");

    session.dispose();
  });

  it("the document dispatch reports per-body verdicts and clears on success", async () => {
    vi.stubGlobal(
      "Worker",
      class {
        addEventListener(): void {}
        removeEventListener(): void {}
        postMessage(): void {}
        terminate(): void {}
      },
    );
    const root = mountSurface();
    const outcomes: SceneDispatchOutcome[] = [];
    const session = bootRenderFixtureSession(
      {
        rootId: ROOT_ID,
        statusId: STATUS_ID,
        volumeId: VOLUME_ID,
        errorId: ERROR_ID,
      },
      () => {},
      { onSceneOutcome: (outcome) => outcomes.push(outcome) },
    );
    // A plain extrude body request (the verdict seam only reads ids and
    // kinds — the computation is the mocked coordinator's business).
    const bodies: readonly DocumentBodySceneRequest[] = [
      {
        bodyId: "body_one",
        scene: {
          kind: "extrude",
          request: {
            loop: [
              {
                kind: "line",
                start: [0, 0] as const,
                end: [10, 0] as const,
              },
              {
                kind: "line",
                start: [10, 0] as const,
                end: [10, 10] as const,
              },
              {
                kind: "line",
                start: [10, 10] as const,
                end: [0, 0] as const,
              },
            ],
            placement: {
              rotation: {
                axis: [0, 0, 1] as const,
                angle: {
                  dimension: "angle" as const,
                  unit: "rad" as const,
                  value: 0,
                },
              },
              translation: {
                x: { dimension: "length", unit: "mm", value: 0 },
                y: { dimension: "length", unit: "mm", value: 0 },
                z: { dimension: "length", unit: "mm", value: 0 },
              },
            },
            distanceMm: 10,
            bodyId: "body_one",
          },
        },
      },
    ];
    session.dispatchDocument(bodies, new Set(["body_one"]));

    // The pass settles with ONE refused body: its structured refusal rides
    // the verdict seam verbatim, and no success verdict clears it.
    const failed = controller.pending[0];
    if (failed === undefined) {
      throw new Error("the document dispatch registered no update");
    }
    failed.settleApplied({
      measurement: {
        failures: [
          { bodyId: "body_one", scene: "extrude", failure: new Error("boom") },
        ],
      },
    });
    await flushMicrotasks();
    expect(outcomes).toEqual([
      { ok: false, scene: "extrude", bodyId: "body_one", text: "boom" },
    ]);
    expect(root.getAttribute("data-dispatched")).toBe("1");

    // A fully built pass reports the success once — clearing the refusal.
    session.dispatchDocument(bodies, new Set(["body_one"]));
    const recovered = controller.pending[1];
    if (recovered === undefined) {
      throw new Error("the recovery dispatch registered no update");
    }
    recovered.settleApplied({ measurement: { failures: [] } });
    await flushMicrotasks();
    expect(outcomes[1]).toEqual({
      ok: true,
      scene: "extrude",
      bodyId: "body_one",
    });

    session.dispose();
  });
});
