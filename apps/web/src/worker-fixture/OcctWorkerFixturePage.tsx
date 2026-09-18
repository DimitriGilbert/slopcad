/**
 * The Phase 21.2 browser fixture: the real OpenCascade kernel executing in
 * a real module Web Worker, wired exactly like the Phase 10 Manifold
 * fixture — the package's `occt-worker.web` entry hosted through the
 * bundler's module-worker syntax (via `./occt-worker-entry`), wrapped in
 * `createWebWorkerTransport`, spoken to through `createWorkerClient`, every
 * parameter change dispatched through `createStaleResultCoordinator`.
 *
 * It differs from the Manifold fixture in three honest ways:
 *
 * - **Exactness.** The scene's volume is asserted against the analytic
 *   value in the exact band (1e-9) — OCCT's BREP integration is exact, so
 *   the surfaced number carries no tolerance story.
 * - **Boot cost as data.** OCCT's boot is a documented, load-bearing cost
 *   (~22 MB WASM asset, ~180 ms-class init probed under Node): the fixture
 *   surfaces the worker's own boot measurement (`data-boot-ms`), the
 *   wall-clock worker creation → boot report latency (`data-ready-ms`), and
 *   the asset's byte size read off the server (`data-wasm-bytes`) — honest
 *   numbers displayed, not hidden.
 * - **Termination settlement.** The dispose control dispatches one request
 *   and synchronously closes the channel in the same task, so the pending
 *   request must settle with the structured `worker/transport-closed`
 *   failure — surfaced as `data-dispose-settlement` for the spec to read.
 *
 * The `#occt-worker-root` data attributes and element ids are the state
 * surface the Playwright spec reads (`e2e-worker/occt-worker.spec.ts`);
 * they are written imperatively at the exact moment their fact becomes
 * true, never batched through React rendering. A SEPARATE route from the
 * Manifold `/worker` fixture by decision: the Manifold spec's counters and
 * baselines stay byte-identical, and the OCCT fixture owns its own surface.
 */

import { useEffect, useRef, useState } from "react";
import { formatBoundsExtents, length } from "@slopcad/cad-core";
import {
  createStaleResultCoordinator,
  createWebWorkerTransport,
  createWorkerClient,
  createWorkerRequestId,
  WorkerRequestFailure,
} from "@slopcad/cad-kernel";
import type { WorkerClient, ComputationContext } from "@slopcad/cad-kernel";
import { occtWorkerBootReport } from "@slopcad/cad-kernel-occt/occt-worker-boot-report";
import type { OcctPlateMeasurement } from "./occt-plate-scene";

import {
  OCCT_HOLE_DIAMETER_DEFAULT_MM,
  OCCT_HOLE_DIAMETER_MAX_MM,
  OCCT_HOLE_DIAMETER_MIN_MM,
  computeOcctDrilledPlate,
} from "./occt-plate-scene";

/** The wired session a booted fixture exposes to the input handler. */
interface OcctWorkerFixtureSession {
  /** Records a parameter change and dispatches its computation. */
  dispatch(holeDiameterMm: number): void;
  /**
   * The termination-settlement probe: dispatches one request and closes the
   * channel in the same synchronous task, recording the structured code the
   * still-pending request settles with.
   */
  disposeNow(): void;
  /** Stops the frame loop and disposes the effect's resources. */
  dispose(): void;
}

/** The fixture's machine-readable counters, mirrored to `#occt-worker-root`. */
interface FixtureCounters {
  dispatched: number;
  settled: number;
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = text;
}

/**
 * Boots the fixture's worker session. Client-only by construction (called
 * from an effect): `Worker` exists in the browser, and the worker entry
 * hosts the real OpenCascade kernel off-thread.
 */
function bootOcctWorkerFixtureSession(): OcctWorkerFixtureSession {
  const workerStartedAt = performance.now();
  const worker = new Worker(
    new URL("./occt-worker-entry.ts", import.meta.url),
    { type: "module" },
  );
  const transport = createWebWorkerTransport(worker);
  const client: WorkerClient = createWorkerClient({ transport });
  const coordinator = createStaleResultCoordinator<OcctPlateMeasurement>({
    client,
  });
  const counters: FixtureCounters = { dispatched: 0, settled: 0 };
  let errorText = "";
  let bootMs: number | null = null;
  let readyMs: number | null = null;
  let wasmBytes: number | null = null;
  let disposed = false;
  let disposeSettlement = "";

  // The boot report is plain non-protocol data the client's parse boundary
  // drops; the fixture's own subscription reads it to surface the boot cost
  // and — once — the asset's byte size read off the server that serves it.
  // The worker is the only side that knows the pinned asset URL, which is
  // why the report carries it: the main thread never imports the binding.
  transport.onMessage((data) => {
    const report = occtWorkerBootReport(data);
    if (report === null || bootMs !== null) return;
    bootMs = report.bootMs;
    readyMs = performance.now() - workerStartedAt;
    writeSurface();
    const assetUrl = new URL(report.wasmUrl, window.location.href).href;
    void fetch(assetUrl, { method: "HEAD" })
      .then((response) => {
        const lengthHeader = response.headers.get("content-length");
        const parsed =
          lengthHeader === null ? Number.NaN : Number(lengthHeader);
        if (Number.isFinite(parsed)) {
          wasmBytes = parsed;
          writeSurface();
        }
      })
      .catch(() => {
        // The fixture keeps working without the size; the attribute stays
        // empty and the spec treats that as missing data, not zero.
      });
  });

  /** Writes the whole state surface in one synchronous pass. */
  function writeSurface(): void {
    const visible = coordinator.visible();
    const inFlight = counters.dispatched - counters.settled;
    const root = document.getElementById("occt-worker-root");
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
      // The full-precision twin of the display value: the exact-band
      // assertions read this — display rounding must not blunt exactness.
      root.setAttribute(
        "data-volume-exact",
        visible === null ? "" : String(visible.state.volume),
      );
      root.setAttribute("data-drops", String(coordinator.drops().length));
      root.setAttribute("data-error", errorText);
      root.setAttribute("data-boot-ms", bootMs === null ? "" : String(bootMs));
      root.setAttribute(
        "data-ready-ms",
        readyMs === null ? "" : String(readyMs),
      );
      root.setAttribute(
        "data-wasm-bytes",
        wasmBytes === null ? "" : String(wasmBytes),
      );
      root.setAttribute("data-disposed", disposed ? "1" : "0");
      root.setAttribute("data-dispose-settlement", disposeSettlement);
    }
    setText(
      "occt-worker-status",
      disposed ? "disposed" : inFlight > 0 ? "computing" : "idle",
    );
    setText(
      "occt-worker-volume",
      visible === null ? "…" : visible.state.volume.toFixed(3),
    );
    setText(
      "occt-worker-bounds",
      visible === null ? "…" : formatBoundsExtents(visible.state.bounds),
    );
    setText(
      "occt-worker-triangles",
      visible === null ? "…" : String(visible.state.triangles),
    );
    setText("occt-worker-in-flight", String(inFlight));
    setText("occt-worker-drops", String(coordinator.drops().length));
    setText(
      "occt-worker-revisions",
      visible === null
        ? `—/${coordinator.currentRevision()}`
        : `${visible.revision}/${coordinator.currentRevision()}`,
    );
    setText("occt-worker-error", errorText);
    setText("occt-worker-boot", bootMs === null ? "…" : bootMs.toFixed(0));
    setText("occt-worker-ready", readyMs === null ? "…" : readyMs.toFixed(0));
    setText(
      "occt-worker-wasm",
      wasmBytes === null
        ? "…"
        : `${(wasmBytes / 1_000_000).toFixed(1)} MB (${wasmBytes})`,
    );
  }

  let ticks = 0;
  let computeFrames = 0;
  function frame(): void {
    ticks += 1;
    // A frame serviced while a computation is in flight is direct evidence
    // the kernel work happened off the main thread — including the boot
    // window, where the worker fetches and compiles the ~22 MB WASM asset.
    if (counters.dispatched > counters.settled && !disposed) computeFrames += 1;
    setText("occt-worker-ticks", String(ticks));
    setText("occt-worker-compute-frames", String(computeFrames));
    rafHandle = requestAnimationFrame(frame);
  }
  let rafHandle = requestAnimationFrame(frame);

  return {
    dispatch(holeDiameterMm: number): void {
      counters.dispatched += 1;
      writeSurface();
      coordinator
        .update((context: ComputationContext) =>
          computeOcctDrilledPlate(context, holeDiameterMm),
        )
        .then(
          () => {
            // Applied and dropped settlements behave identically here: a
            // superseded computation never became visible and the
            // coordinator recorded the drop, so `writeSurface()` still
            // shows the newest applied revision either way.
            counters.settled += 1;
            writeSurface();
          },
          (failure: unknown) => {
            counters.settled += 1;
            errorText =
              failure instanceof Error ? failure.message : String(failure);
            writeSurface();
          },
        );
    },
    disposeNow(): void {
      if (disposed) return;
      disposed = true;
      // One request under an explicit, channel-unique id — the coordinator
      // mints its computation ids from its own generator, so a default-
      // minted id here would collide with the session's first computation
      // request (`worker/duplicate-request`, single-use ids per channel) —
      // then the channel dies inside the same synchronous task: no response
      // can be processed before close, so the settlement below is
      // deterministic, not a race.
      const inFlight = client.request(
        "solid.createSphere",
        { radius: length(1, "mm") },
        createWorkerRequestId("req_occt-dispose-probe"),
      );
      inFlight.then(
        () => {
          disposeSettlement = "unexpected-success";
          writeSurface();
        },
        (failure: unknown) => {
          disposeSettlement =
            failure instanceof WorkerRequestFailure
              ? failure.error.code
              : "unexpected-failure-shape";
          writeSurface();
        },
      );
      client.close();
      worker.terminate();
      writeSurface();
    },
    dispose(): void {
      cancelAnimationFrame(rafHandle);
      client.close();
      worker.terminate();
    },
  };
}

export function OcctWorkerFixturePage() {
  const [holeDiameter, setHoleDiameter] = useState(
    OCCT_HOLE_DIAMETER_DEFAULT_MM,
  );
  const [booted, setBooted] = useState(false);
  const sessionRef = useRef<OcctWorkerFixtureSession | null>(null);

  useEffect(() => {
    const session = bootOcctWorkerFixtureSession();
    sessionRef.current = session;
    setBooted(true);
    session.dispatch(OCCT_HOLE_DIAMETER_DEFAULT_MM);
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
  }, []);

  return (
    <div
      id="occt-worker-root"
      className="mx-auto w-full max-w-xl space-y-4 p-6"
      data-dispatched="0"
      data-settled="0"
      data-in-flight="0"
      data-current-revision="0"
      data-applied-revision=""
      data-volume=""
      data-volume-exact=""
      data-drops="0"
      data-error=""
      data-boot-ms=""
      data-ready-ms=""
      data-wasm-bytes=""
      data-disposed="0"
      data-dispose-settlement=""
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 21.2 OCCT Worker Fixture
        </h1>
        <p className="text-muted-foreground text-sm">
          Real OpenCascade kernel in a real Web Worker: 12-bore plate →
          subtracts → rotation placement → measure, through the worker protocol.
          Every value below is computed off-thread or counted by the
          stale-result coordinator; the boot cost is surfaced, not hidden.
        </p>
      </div>
      <label className="block text-sm" htmlFor="param-occt-hole-diameter">
        <span className="mb-1 block font-medium">
          holeDiameter (mm), {OCCT_HOLE_DIAMETER_MIN_MM}–
          {OCCT_HOLE_DIAMETER_MAX_MM}
        </span>
        <input
          id="param-occt-hole-diameter"
          className="border-input bg-background w-full rounded border px-2 py-1 font-mono"
          type="number"
          min={OCCT_HOLE_DIAMETER_MIN_MM}
          max={OCCT_HOLE_DIAMETER_MAX_MM}
          step={0.5}
          disabled={!booted}
          value={holeDiameter}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (
              Number.isFinite(parsed) &&
              parsed >= OCCT_HOLE_DIAMETER_MIN_MM &&
              parsed <= OCCT_HOLE_DIAMETER_MAX_MM
            ) {
              setHoleDiameter(parsed);
              sessionRef.current?.dispatch(parsed);
            }
          }}
        />
      </label>
      <ul className="space-y-1 font-mono text-xs">
        <li>
          status = <span id="occt-worker-status">boot</span>
        </li>
        <li>
          volume = <span id="occt-worker-volume">…</span>
          {"\u00A0"}mm³ (exact band)
        </li>
        <li>
          bounds = <span id="occt-worker-bounds">…</span>
          {"\u00A0"}mm
        </li>
        <li>
          triangles = <span id="occt-worker-triangles">…</span>
        </li>
        <li>
          revisions (applied/current) ={" "}
          <span id="occt-worker-revisions">…</span>
        </li>
        <li>
          in-flight = <span id="occt-worker-in-flight">0</span>
        </li>
        <li>
          stale drops = <span id="occt-worker-drops">0</span>
        </li>
        <li>
          main-thread frames = <span id="occt-worker-ticks">0</span> (during
          compute: <span id="occt-worker-compute-frames">0</span>)
        </li>
        <li>
          worker boot = <span id="occt-worker-boot">…</span>
          {"\u00A0"}ms (init), ready after <span id="occt-worker-ready">…</span>
          {"\u00A0"}ms (wall clock incl. fetch), asset{"\u00A0"}
          <span id="occt-worker-wasm">…</span>
          {"\u00A0"}bytes
        </li>
        <li data-testid="occt-worker-error" className="text-red-500">
          <span id="occt-worker-error" />
        </li>
      </ul>
      <button
        id="occt-worker-dispose"
        type="button"
        className="border-input bg-background rounded border px-3 py-1 text-xs"
        onClick={() => {
          sessionRef.current?.disposeNow();
        }}
      >
        dispatch one request, then terminate the worker
      </button>
    </div>
  );
}
