/**
 * The Phase 11.3 browser fixture: the real Manifold kernel executing in a
 * real module Web Worker (the Phase 10 worker-fixture wiring, re-hosted)
 * computes the plate, the measurement converts through the public cad-core
 * projection boundary into a {@link RenderProjection} with its deterministic
 * camera spec, and the cad-r3f `CadScene` renders it — grid, world axes,
 * origin marker, fixed light rig, spec camera — under demand-frameloop
 * discipline.
 *
 * The `#render-root` data attributes and element ids below are the
 * machine-readable surface the Phase 11.3 Playwright spec reads
 * (`e2e-render/render.spec.ts`), written at the exact moment their fact
 * becomes true:
 *
 * - `data-volume` — the settled computation's volume, written synchronously
 *   with the coordinator's settlement;
 * - `data-cad-rendered-volume` — stamped by the scene's `onSettled` on the
 *   first demand frame that carries the current projection's geometry. The
 *   settle protocol is the spike's: pixels belong to the numbers only when
 *   the two attributes are equal (and no computation is in flight at the
 *   newest revision).
 */

import { useEffect, useRef, useState } from "react";
import {
  createStaleResultCoordinator,
  createWebWorkerTransport,
  createWorkerClient,
} from "@slopcad/cad-kernel";
import type { WorkerClient } from "@slopcad/cad-kernel";
import { CadScene } from "@slopcad/cad-r3f";
import type { PlateMeasurement } from "../worker-fixture/plate-scene";

import {
  PLATE_HOLE_DIAMETER_DEFAULT_MM,
  PLATE_HOLE_DIAMETER_MAX_MM,
  PLATE_HOLE_DIAMETER_MIN_MM,
} from "../worker-fixture/plate-scene";
import {
  computePlateRenderState,
  type PlateRenderState,
} from "./plate-render-scene";

/** The wired session a booted fixture exposes. */
interface RenderFixtureSession {
  /** Records a parameter change and dispatches its computation. */
  dispatch(holeDiameterMm: number): void;
  /** Settles the channel and terminates the worker. */
  dispose(): void;
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = text;
}

/** Bounds rendered as extents, the fixtures' `30.000 × 20.000 × 10.000` form. */
function formatBoundsExtents(measurement: PlateMeasurement): string {
  const { min, max } = measurement.bounds;
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    .map((extent) => extent.toFixed(3))
    .join(" × ");
}

/**
 * Boots the fixture's worker session (client-only, called from an effect).
 * `onApplied` receives every render state that became the visible one —
 * in application order, newest-wins through the stale-result coordinator.
 */
function bootRenderFixtureSession(
  onApplied: (state: PlateRenderState) => void,
): RenderFixtureSession {
  const worker = new Worker(
    new URL("../worker-fixture/manifold-worker-entry.ts", import.meta.url),
    { type: "module" },
  );
  const client: WorkerClient = createWorkerClient({
    transport: createWebWorkerTransport(worker),
  });
  const coordinator = createStaleResultCoordinator<PlateRenderState>({
    client,
  });
  const counters = { dispatched: 0, settled: 0 };
  let errorText = "";

  /** Writes the whole coordinator-driven state surface in one pass. */
  function writeSurface(): void {
    const visible = coordinator.visible();
    const inFlight = counters.dispatched - counters.settled;
    const root = document.getElementById("render-root");
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
        visible === null ? "" : visible.state.measurement.volume.toFixed(3),
      );
      root.setAttribute("data-error", errorText);
    }
    setText("render-status", inFlight > 0 ? "computing" : "idle");
    setText(
      "render-volume",
      visible === null ? "…" : visible.state.measurement.volume.toFixed(3),
    );
    setText(
      "render-bounds",
      visible === null ? "…" : formatBoundsExtents(visible.state.measurement),
    );
    setText(
      "render-triangles",
      visible === null ? "…" : String(visible.state.measurement.triangles),
    );
    setText(
      "render-revisions",
      visible === null
        ? `—/${coordinator.currentRevision()}`
        : `${visible.revision}/${coordinator.currentRevision()}`,
    );
    setText("render-error", errorText);
  }

  return {
    dispatch(holeDiameterMm: number): void {
      counters.dispatched += 1;
      writeSurface();
      coordinator
        .update((context) => computePlateRenderState(context, holeDiameterMm))
        .then(
          () => {
            counters.settled += 1;
            writeSurface();
            // The coordinator's visible state is the authority (a superseded
            // computation settles without ever becoming visible).
            const visible = coordinator.visible();
            if (visible !== null) onApplied(visible.state);
          },
          (failure: unknown) => {
            counters.settled += 1;
            errorText =
              failure instanceof Error ? failure.message : String(failure);
            writeSurface();
          },
        );
    },
    dispose(): void {
      client.close();
      worker.terminate();
    },
  };
}

export function RenderFixturePage() {
  const [holeDiameter, setHoleDiameter] = useState(
    PLATE_HOLE_DIAMETER_DEFAULT_MM,
  );
  const [state, setState] = useState<PlateRenderState | null>(null);
  const [booted, setBooted] = useState(false);
  const sessionRef = useRef<RenderFixtureSession | null>(null);

  useEffect(() => {
    const session = bootRenderFixtureSession(setState);
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
      id="render-root"
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      data-dispatched="0"
      data-settled="0"
      data-in-flight="0"
      data-current-revision="0"
      data-applied-revision=""
      data-volume=""
      data-cad-rendered-volume=""
      data-error=""
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 11.3 Deterministic Scene Fixture
        </h1>
        <p className="text-muted-foreground text-sm">
          Real Manifold worker → plate → render projection (camera spec
          included) → deterministic CAD scene: grid, axes, origin, fixed light
          rig, demand frameloop.
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-64 shrink-0 space-y-4">
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
              status = <span id="render-status">boot</span>
            </li>
            <li>
              volume = <span id="render-volume">…</span>
              {"\u00A0"}mm³
            </li>
            <li>
              bounds = <span id="render-bounds">…</span>
              {"\u00A0"}mm
            </li>
            <li>
              triangles = <span id="render-triangles">…</span>
            </li>
            <li>
              revisions (applied/current) = <span id="render-revisions">…</span>
            </li>
            <li data-testid="render-error" className="text-red-500">
              <span id="render-error" />
            </li>
          </ul>
        </div>
        {/* Fixed pixel box: part of the determinism contract (the camera
            spec is authored for this exact viewport; DPR comes from the
            scene's dpr={1}). */}
        <div
          id="render-viewport"
          className="h-[520px] w-[800px] shrink-0 overflow-hidden border"
        >
          {state === null ? (
            <div className="flex h-full items-center justify-center text-sm">
              evaluating…
            </div>
          ) : (
            <CadScene
              projection={state.projection}
              onSettled={() => {
                document
                  .getElementById("render-root")
                  ?.setAttribute(
                    "data-cad-rendered-volume",
                    state.measurement.volume.toFixed(3),
                  );
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
