/**
 * The Phase 10 browser fixture: the real Manifold kernel executing in a
 * real module Web Worker, wired exactly per the documented pattern — the
 * package's `manifold-worker.web` entry hosted through the bundler's
 * module-worker syntax (via `./manifold-worker-entry`), wrapped in
 * `createWebWorkerTransport`, spoken to through `createWorkerClient`, and
 * every parameter change dispatched through `createStaleResultCoordinator`
 * so rapid updates leave exactly the newest revision's result visible.
 *
 * This is the production path, not the spike island: no geometry is
 * computed on the main thread, and every displayed value comes either from
 * the worker's measurements (volume, bounds, triangles) or from the
 * coordinator's own bookkeeping (revisions, drops, in-flight counts). The
 * `#worker-root` data attributes and the element ids below are the state
 * surface the Phase 10 Playwright spec reads (`e2e-worker/worker.spec.ts`);
 * they are written imperatively at the exact moment their fact becomes
 * true — synchronous with the coordinator's dispatch and settlement — never
 * batched or delayed through React rendering.
 */

import { useEffect, useRef, useState } from "react";
import {
  createStaleResultCoordinator,
  createWebWorkerTransport,
  createWorkerClient,
} from "@slopcad/cad-kernel";
import type { WorkerClient } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";

import {
  PLATE_HOLE_DIAMETER_DEFAULT_MM,
  PLATE_HOLE_DIAMETER_MAX_MM,
  PLATE_HOLE_DIAMETER_MIN_MM,
  computePlateWithHole,
} from "./plate-scene";

/** The wired session a booted fixture exposes to the input handler. */
interface WorkerFixtureSession {
  /** Records a parameter change and dispatches its computation. */
  dispatch(holeDiameterMm: number): void;
  /** Stops the frame loop, settles the channel, and terminates the worker. */
  dispose(): void;
}

/** The fixture's machine-readable counters, mirrored to `#worker-root`. */
interface FixtureCounters {
  dispatched: number;
  settled: number;
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = text;
}

/** Bounds rendered as extents, the spike's `30.000 × 20.000 × 10.000` form. */
function formatBoundsExtents(measurement: PlateMeasurement): string {
  const { min, max } = measurement.bounds;
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    .map((extent) => extent.toFixed(3))
    .join(" × ");
}

/**
 * Boots the fixture's worker session. Client-only by construction (called
 * from an effect): `Worker` exists in the browser, and the worker entry
 * hosts the real Manifold kernel off-thread.
 */
function bootWorkerFixtureSession(): WorkerFixtureSession {
  const worker = new Worker(
    new URL("./manifold-worker-entry.ts", import.meta.url),
    { type: "module" },
  );
  const client: WorkerClient = createWorkerClient({
    transport: createWebWorkerTransport(worker),
  });
  const coordinator = createStaleResultCoordinator<PlateMeasurement>({
    client,
  });
  const counters: FixtureCounters = { dispatched: 0, settled: 0 };
  let errorText = "";

  /** Writes the whole state surface in one synchronous pass. */
  function writeSurface(): void {
    const visible = coordinator.visible();
    const inFlight = counters.dispatched - counters.settled;
    const root = document.getElementById("worker-root");
    if (root !== null) {
      root.setAttribute("data-dispatched", String(counters.dispatched));
      root.setAttribute("data-settled", String(counters.settled));
      root.setAttribute("data-in-flight", String(inFlight));
      root.setAttribute(
        "data-current-revision",
        String(coordinator.currentRevision()),
      );
      root.setAttribute(
        "data-applied-revision",
        visible === null ? "" : String(visible.revision),
      );
      root.setAttribute(
        "data-volume",
        visible === null ? "" : visible.state.volume.toFixed(3),
      );
      root.setAttribute("data-drops", String(coordinator.drops().length));
      root.setAttribute("data-error", errorText);
    }
    setText("worker-status", inFlight > 0 ? "computing" : "idle");
    setText("worker-volume", visible === null ? "…" : visible.state.volume.toFixed(3));
    setText(
      "worker-bounds",
      visible === null ? "…" : formatBoundsExtents(visible.state),
    );
    setText("worker-triangles", visible === null ? "…" : String(visible.state.triangles));
    setText("worker-in-flight", String(inFlight));
    setText("worker-drops", String(coordinator.drops().length));
    setText(
      "worker-revisions",
      visible === null
        ? `—/${coordinator.currentRevision()}`
        : `${visible.revision}/${coordinator.currentRevision()}`,
    );
    setText("worker-error", errorText);
  }

  let ticks = 0;
  let computeFrames = 0;
  function frame(): void {
    ticks += 1;
    // A frame serviced while a computation is in flight is direct evidence
    // the kernel work happened off the main thread.
    if (counters.dispatched > counters.settled) computeFrames += 1;
    setText("worker-ticks", String(ticks));
    setText("worker-compute-frames", String(computeFrames));
    rafHandle = requestAnimationFrame(frame);
  }
  let rafHandle = requestAnimationFrame(frame);

  return {
    dispatch(holeDiameterMm: number): void {
      counters.dispatched += 1;
      writeSurface();
      coordinator
        .update((context) => computePlateWithHole(context, holeDiameterMm))
        .then(
          () => {
            // Applied and dropped settlements behave identically here: a
            // superseded computation never became visible and the coordinator
            // recorded the drop, so `writeSurface()` still shows the newest
            // applied revision either way.
            counters.settled += 1;
            writeSurface();
          },
          (failure: unknown) => {
            counters.settled += 1;
            errorText = failure instanceof Error ? failure.message : String(failure);
            writeSurface();
          },
        );
    },
    dispose(): void {
      cancelAnimationFrame(rafHandle);
      client.close();
      worker.terminate();
    },
  };
}

export function WorkerFixturePage() {
  const [holeDiameter, setHoleDiameter] = useState(
    PLATE_HOLE_DIAMETER_DEFAULT_MM,
  );
  const [booted, setBooted] = useState(false);
  const sessionRef = useRef<WorkerFixtureSession | null>(null);

  useEffect(() => {
    const session = bootWorkerFixtureSession();
    sessionRef.current = session;
    setBooted(true);
    session.dispatch(PLATE_HOLE_DIAMETER_DEFAULT_MM);
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
  }, []);

  return (
    <div
      id="worker-root"
      className="mx-auto w-full max-w-xl space-y-4 p-6"
      data-dispatched="0"
      data-settled="0"
      data-in-flight="0"
      data-current-revision="0"
      data-applied-revision=""
      data-volume=""
      data-drops="0"
      data-error=""
    >
      <div>
        <h1 className="text-lg font-semibold">Phase 10 Worker Fixture</h1>
        <p className="text-muted-foreground text-sm">
          Real Manifold kernel in a real Web Worker: plate → bore → subtract →
          measure, through the worker protocol. Every value below is computed
          off-thread or counted by the stale-result coordinator.
        </p>
      </div>
      <label className="block text-sm" htmlFor="param-holeDiameter">
        <span className="mb-1 block font-medium">
          holeDiameter (mm), {PLATE_HOLE_DIAMETER_MIN_MM}–
          {PLATE_HOLE_DIAMETER_MAX_MM}
        </span>
        <input
          id="param-holeDiameter"
          className="border-input bg-background w-full rounded border px-2 py-1 font-mono"
          type="number"
          min={PLATE_HOLE_DIAMETER_MIN_MM}
          max={PLATE_HOLE_DIAMETER_MAX_MM}
          step={0.5}
          disabled={!booted}
          value={holeDiameter}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (
              Number.isFinite(parsed) &&
              parsed >= PLATE_HOLE_DIAMETER_MIN_MM &&
              parsed <= PLATE_HOLE_DIAMETER_MAX_MM
            ) {
              setHoleDiameter(parsed);
              sessionRef.current?.dispatch(parsed);
            }
          }}
        />
      </label>
      <ul className="space-y-1 font-mono text-xs">
        <li>
          status = <span id="worker-status">boot</span>
        </li>
        <li>
          volume = <span id="worker-volume">…</span>{"\u00A0"}mm³
        </li>
        <li>
          bounds = <span id="worker-bounds">…</span>{"\u00A0"}mm
        </li>
        <li>
          triangles = <span id="worker-triangles">…</span>
        </li>
        <li>
          revisions (applied/current) = <span id="worker-revisions">…</span>
        </li>
        <li>
          in-flight = <span id="worker-in-flight">0</span>
        </li>
        <li>
          stale drops = <span id="worker-drops">0</span>
        </li>
        <li>
          main-thread frames = <span id="worker-ticks">0</span> (during
          compute: <span id="worker-compute-frames">0</span>)
        </li>
        <li data-testid="worker-error" className="text-red-500">
          <span id="worker-error" />
        </li>
      </ul>
    </div>
  );
}
