/**
 * The Phase 29 `/perf` fixture: the browser-real benchmark page. It runs
 * the in-page measurement suite ({@link runInPageMeasurements} — worker/
 * WASM startup, per-operation round trips, projection, transfer proxy,
 * graph invalidation) and then the SCENE probe over the same production
 * coordinator session + `CadScene` the other fixtures use, collecting:
 *
 * - `scene.paramUpdate.dispatchToSettledMs` — parameter change dispatched
 *   through the real stale-result-coordinated worker session until the
 *   scene's settle probe reports the first frame carrying the new
 *   projection (the end-to-end update latency of the fixture pipeline).
 * - `scene.paramUpdate.dispatchToAppliedMs` — the same dispatch to the
 *   coordinator's applied callback: the worker + coordinator share of the
 *   update (the compute).
 * - `scene.paramUpdate.applyToFrameMs` — the applied callback to the settle
 *   probe's frame: the React commit + effects + frame-clock share. This is
 *   the production-build "React render time" metric — React's Profiler API
 *   is a NO-OP in production bundles (its onRender never fires there; the
 *   Phase 29 baseline run proved it: zero commits observed), so the honest
 *   production measurement is the observable apply → first-frame window.
 * - `scene.firstSettle.ms` — session boot (worker creation) to the first
 *   settled frame: startup + first full computation end to end.
 *
 * Everything is published as one JSON surface on `#perf-root`'s
 * `data-perf-results` attribute (`phase: "done"`), which the Playwright
 * perf harness (`e2e-perf/perf.spec.ts`) collects, aggregates, writes to
 * the artifacts, and checks against the recorded budgets.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CadScene } from "@slopcad/cad-r3f";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import {
  bootRenderFixtureSession,
  type RenderFixtureSession,
} from "../render-fixture/fixture-session";
import { PLATE_HOLE_DIAMETER_DEFAULT_MM } from "../worker-fixture/plate-scene";
import {
  runInPageMeasurements,
  type InPageMeasurements,
} from "./perf-measurements";

/**
 * The diameters the scene probe cycles through — every value within the
 * fixture's accepted range, no consecutive repeats.
 */
const SCENE_DIAMETERS: readonly number[] = [
  9, 10, 11, 12, 9.5, 10.5, 8.5, 12.5, 9.5, 10,
];

/** Guard for a settle that never comes (a hung worker, a dropped frame). */
const SETTLE_DEADLINE_MS = 30_000;

/** The whole published benchmark surface. */
interface PerfResults {
  readonly phase: "booting" | "measuring" | "done" | "failed";
  readonly error?: string;
  readonly startedAt: string;
  readonly environment?: InPageMeasurements["environment"];
  readonly geometry?: InPageMeasurements["geometry"];
  readonly samples: Readonly<Record<string, readonly number[]>>;
}

/** Rejects with `message` if `promise` outlives `deadlineMs`. */
function withTimeout(
  promise: Promise<void>,
  deadlineMs: number,
  message: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), deadlineMs);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export function PerfFixturePage(): ReactElement {
  const [results, setResults] = useState<PerfResults>({
    phase: "booting",
    startedAt: "",
    samples: {},
  });
  const [applied, setApplied] = useState<{
    readonly state: PlateRenderState;
    readonly revision: number;
  } | null>(null);

  const sessionRef = useRef<RenderFixtureSession | null>(null);
  // Settle waiters, in dispatch order: the settle probe resolves exactly
  // one waiter per projection change (the update's end-to-end completion).
  const settleWaitersRef = useRef<readonly (() => void)[]>([]);
  // The pending scene update: when it was dispatched, and when its result
  // became the applied state (the worker share vs the frame share).
  const pendingRef = useRef<{
    readonly dispatchedAt: number;
    appliedAt: number | null;
  } | null>(null);
  // The latest applied-state timestamp (the settle pairs against it).
  const appliedAtRef = useRef<number | null>(null);
  // One live run at a time: a run owns the shared probe state (settle
  // waiters, session, results) until it settles, so a second invocation
  // must be a no-op, never an interleaved concurrent run that would poison
  // the first (the disabled rerun button is the primary gate; this guard
  // covers every other entry point).
  const runInFlightRef = useRef(false);

  const resolveNextSettle = useCallback((): void => {
    const [first, ...rest] = settleWaitersRef.current;
    settleWaitersRef.current = rest;
    first?.();
  }, []);

  /** Waits for the settle probe to report the next projection change. */
  const waitForSettle = useCallback((): Promise<void> => {
    return new Promise<void>((resolve) => {
      settleWaitersRef.current = [...settleWaitersRef.current, resolve];
    });
  }, []);

  /** The whole benchmark sequence: measurements, then the scene probe. */
  const runBenchmark = useCallback(async (): Promise<void> => {
    if (runInFlightRef.current) {
      return;
    }
    runInFlightRef.current = true;
    try {
      setApplied(null);
      setResults({
        phase: "measuring",
        startedAt: new Date().toISOString(),
        samples: {},
      });
      const samples: Record<string, number[]> = {};
      let measured: InPageMeasurements | null = null;
      try {
        measured = await runInPageMeasurements();
        for (const [key, values] of Object.entries(measured.samples)) {
          samples[key] = [...values];
        }

        // The scene probe: the production coordinator session + CadScene.
        const dispatchToSettledSamples: number[] = [];
        const dispatchToAppliedSamples: number[] = [];
        const applyToFrameSamples: number[] = [];
        const bootStarted = performance.now();
        const session = bootRenderFixtureSession(
          {
            rootId: "perf-root",
            statusId: "perf-status",
            volumeId: "perf-volume",
            errorId: "perf-error",
          },
          (state, revision) => {
            appliedAtRef.current = performance.now();
            if (pendingRef.current !== null) {
              pendingRef.current = {
                ...pendingRef.current,
                appliedAt: appliedAtRef.current,
              };
            }
            setApplied({ state, revision });
          },
        );
        sessionRef.current = session;
        settleWaitersRef.current = [];

        // The first dispatch; its settle resolves the boot measurement.
        const firstSettle = waitForSettle();
        session.dispatch(PLATE_HOLE_DIAMETER_DEFAULT_MM);
        await withTimeout(
          firstSettle,
          SETTLE_DEADLINE_MS,
          "The scene probe's first dispatch never settled.",
        );
        samples["scene.firstSettle.ms"] = [performance.now() - bootStarted];

        // The update loop: one dispatch at a time, each awaited through the
        // settle probe — sequential edits, no racing (cancellation behavior
        // under rapid updates is the worker spec's domain, not this probe's).
        for (const diameter of SCENE_DIAMETERS) {
          const settle = waitForSettle();
          pendingRef.current = {
            dispatchedAt: performance.now(),
            appliedAt: null,
          };
          session.dispatch(diameter);
          await withTimeout(
            settle,
            SETTLE_DEADLINE_MS,
            `The scene probe's dispatch (${String(diameter)} mm) never settled.`,
          );
          const pending = pendingRef.current;
          pendingRef.current = null;
          const settledAt = performance.now();
          if (pending !== null) {
            dispatchToSettledSamples.push(settledAt - pending.dispatchedAt);
            if (pending.appliedAt !== null) {
              dispatchToAppliedSamples.push(
                pending.appliedAt - pending.dispatchedAt,
              );
              applyToFrameSamples.push(settledAt - pending.appliedAt);
            }
          }
          // Let the post-settle React state (applied revision, surface
          // writes) land before the next dispatch.
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        session.dispose();
        sessionRef.current = null;
        samples["scene.paramUpdate.dispatchToSettledMs"] =
          dispatchToSettledSamples;
        samples["scene.paramUpdate.dispatchToAppliedMs"] =
          dispatchToAppliedSamples;
        samples["scene.paramUpdate.applyToFrameMs"] = applyToFrameSamples;
      } catch (error) {
        sessionRef.current?.dispose();
        sessionRef.current = null;
        setResults({
          phase: "failed",
          startedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
          environment: measured?.environment,
          geometry: measured?.geometry,
          samples: Object.freeze(samples),
        });
        return;
      }
      setResults({
        phase: "done",
        startedAt: new Date().toISOString(),
        environment: measured.environment,
        geometry: measured.geometry,
        samples: Object.freeze(samples),
      });
    } finally {
      runInFlightRef.current = false;
    }
  }, [waitForSettle]);

  useEffect(() => {
    void runBenchmark();
    return () => {
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, [runBenchmark]);

  return (
    <div
      id="perf-root"
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      data-perf-phase={results.phase}
      data-perf-results={JSON.stringify(results)}
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 29 Performance Fixture (real pipeline)
        </h1>
        <p className="text-muted-foreground text-sm">
          Real Manifold worker → plate chain → projection → deterministic CAD
          scene, measured: worker/WASM startup, per-operation round trips,
          tessellation transfer, projection, graph invalidation, parameter
          update settle, and React commit work. Results publish as JSON on this
          root's data-perf-results attribute.
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-64 shrink-0 space-y-2 font-mono text-xs">
          <div>
            phase = <span id="perf-phase">{results.phase}</span>
          </div>
          <div>
            status = <span id="perf-status">boot</span>
          </div>
          <div>
            volume = <span id="perf-volume">…</span> mm³
          </div>
          <div>
            metrics ={" "}
            <span id="perf-metric-count">
              {String(Object.keys(results.samples).length)}
            </span>
          </div>
          {results.error !== undefined ? (
            <li data-testid="perf-error" className="text-red-500">
              <span id="perf-error" />
            </li>
          ) : null}
          <div>
            <button
              id="perf-rerun"
              className="border-input bg-background rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={results.phase === "measuring"}
              onClick={() => {
                void runBenchmark();
              }}
            >
              Run again
            </button>
          </div>
        </div>
        {/* The same fixed pixel box + real CadScene the scene probe
            measures (dispatch → applied → settled frame). */}
        <div
          id="perf-viewport"
          className="h-[520px] w-[800px] shrink-0 overflow-hidden border"
        >
          {applied === null ? (
            <div className="flex h-full items-center justify-center text-sm">
              measuring…
            </div>
          ) : (
            <CadScene
              projection={applied.state.projection}
              onSettled={() => {
                document
                  .getElementById("perf-root")
                  ?.setAttribute(
                    "data-cad-rendered-volume",
                    applied.state.measurement.volume.toFixed(3),
                  );
                resolveNextSettle();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
