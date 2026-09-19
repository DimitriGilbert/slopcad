/**
 * The Phase 26.5 browser fixture: the real OpenCascade kernel executing the
 * box → topology → fillet chain in a real module Web Worker, on the same
 * hosting pattern as the Phase 21.2 `/worker-occt` fixture (the package's
 * web worker entry, the crash-settling `bootWorkerChannel`,
 * `createStaleResultCoordinator` — every apply is a fresh dispatch,
 * newest-wins).
 *
 * ## The edge-picking design (the 26.5 picking layer)
 *
 * Edges are picked THROUGH THE TOPOLOGY SNAPSHOT, not through mesh
 * inference: the worker's `solid.topology` answer carries every edge's
 * snapshot ordinal and kernel-measured centroid; the page projects each
 * centroid through the SAME deterministic camera the scene renders with
 * (`extrudeCamera` over the measured bounds, `renderCameraScreenPoint` into
 * the fixture's fixed 800×520 viewport) and publishes the anchors as
 * `data-edge-anchors`. A click on the viewport selects the nearest anchor
 * within {@link EDGE_PICK_RADIUS_PX} — the pick IS a snapshot ordinal, the
 * very address `solid.fillet` consumes. No synthetic mesh grouping is
 * invented for edges: on a persistent-topology kernel the snapshot is the
 * honest edge identity, and its ordinals are exactly the kernel's
 * addressing vocabulary. Picking is live only in the `picking` stage (a
 * filleted scene has different edges; re-fillet from the same selection via
 * the radius field).
 *
 * ## Machine surface (`#occt-fillet-root`)
 *
 * The shared settle protocol (`data-in-flight`, `data-applied-revision`,
 * `data-current-revision`, `data-volume`, `data-cad-rendered-volume`), the
 * full-precision twin `data-volume-exact`, `data-stage` (`picking` before a
 * fillet, `filleted` after), `data-selected-edge` (the picked ordinal),
 * `data-edge-anchors` (the projected picking map), and `data-error` (the
 * structured kernel failure — code plus message — when a dispatch rejects,
 * e.g. an oversized radius).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CadScene, renderCameraScreenPoint } from "@slopcad/cad-r3f";
import {
  createStaleResultCoordinator,
  bootWorkerChannel,
  WorkerRequestFailure,
} from "@slopcad/cad-kernel";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import {
  extrudeCamera,
  extrudeRenderState,
} from "../render-fixture/plate-render-scene";
import {
  computeFilletScene,
  FILLET_BODY_ID,
  type FilletScene,
} from "./fillet-scene";

/** The fixture's fixed viewport, in CSS pixels (the camera spec's frame). */
const VIEWPORT_CSS_WIDTH = 800;
const VIEWPORT_CSS_HEIGHT = 520;

/** Maximum distance (CSS px) a click may land from an anchor to pick it. */
export const EDGE_PICK_RADIUS_PX = 24;

/** The radius the fixture's radius field starts with (mm). */
export const FILLET_DEFAULT_RADIUS_MM = 3;

/** The dispatch parameters one fillet scene computation runs with. */
interface FilletDispatch {
  /** The selected snapshot edge ordinal, or `null` for the picking stage. */
  readonly edgeOrdinal: number | null;
  /** The fillet radius (mm), or `null` for the picking stage. */
  readonly radiusMm: number | null;
}

/** The coordinator's settled state: the render state plus its scene data. */
interface FilletSceneView {
  readonly render: PlateRenderState;
  readonly scene: FilletScene;
}

/** One applied computation, with its revision identity. */
interface AppliedFilletView {
  readonly view: FilletSceneView;
  readonly revision: number;
}

/** The wired session the booted fixture exposes. */
interface OcctFilletSession {
  /** Dispatches one full scene computation (box → topology → fillet). */
  dispatch(request: FilletDispatch): void;
  /** Settles the channel and terminates the worker. */
  dispose(): void;
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = text;
}

/** The settled solid of a scene view: the filleted one when one ran. */
function settledVolumeOf(view: FilletSceneView): number {
  return (view.scene.filleted ?? view.scene.box).volume;
}

/**
 * The projected edge anchors of the picking stage: per snapshot edge
 * ordinal, the CSS-pixel anchor point and the kernel-measured length.
 * Deterministic — a pure function of the box scene — so the spec derives
 * every pick from the surface (the house rule: no guessed pixels).
 */
export function edgeAnchorSurface(scene: FilletScene): string {
  const camera = extrudeCamera(scene.box.bounds);
  const anchors: Record<
    string,
    {
      readonly point: readonly [number, number];
      readonly lengthMm: number;
      readonly centroidMm: readonly [number, number, number];
    }
  > = {};
  for (const edge of scene.edges) {
    const screen = renderCameraScreenPoint(
      camera,
      edge.centroidMm,
      VIEWPORT_CSS_WIDTH,
      VIEWPORT_CSS_HEIGHT,
    );
    anchors[String(edge.ordinal)] = {
      point: [Number(screen[0].toFixed(1)), Number(screen[1].toFixed(1))],
      lengthMm: Number(edge.lengthMm.toFixed(3)),
      centroidMm: edge.centroidMm,
    };
  }
  return JSON.stringify(anchors);
}

/** Boots the fixture's OCCT worker session (client-only, from an effect). */
function bootOcctFilletSession(
  onApplied: (applied: AppliedFilletView) => void,
): OcctFilletSession {
  let errorText = "";
  // The crash-settling boot (Phase 35 hardening): a dead thread settles
  // in-flight requests (worker/transport-closed) instead of hanging, and
  // the crash lands on the same error surface as fillet failures.
  const boot = bootWorkerChannel(
    new Worker(new URL("./occt-worker-entry.ts", import.meta.url), {
      type: "module",
    }),
    (failure) => {
      errorText = `worker channel failed (${failure.kind}): ${failure.message}`;
      writeSurface();
    },
  );
  const coordinator = createStaleResultCoordinator<FilletSceneView>({
    client: boot.client,
  });
  const counters = { dispatched: 0, settled: 0 };

  function writeSurface(): void {
    const visible = coordinator.visible();
    const inFlight = counters.dispatched - counters.settled;
    const root = document.getElementById("occt-fillet-root");
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
      const volume = visible === null ? null : settledVolumeOf(visible.state);
      root.setAttribute(
        "data-volume",
        volume === null ? "" : volume.toFixed(3),
      );
      root.setAttribute(
        "data-volume-exact",
        volume === null ? "" : String(volume),
      );
      root.setAttribute(
        "data-stage",
        visible === null || visible.state.scene.filleted === null
          ? "picking"
          : "filleted",
      );
      root.setAttribute("data-error", errorText);
    }
    const status =
      inFlight > 0 ? "computing" : errorText === "" ? "idle" : "failed";
    setText("occt-fillet-status", status);
    setText(
      "occt-fillet-volume",
      visible === null ? "…" : settledVolumeOf(visible.state).toFixed(3),
    );
    setText("occt-fillet-error", errorText);
  }

  return {
    dispatch(request: FilletDispatch): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) => {
          const scene = await computeFilletScene(context, request);
          return {
            scene,
            render: extrudeRenderState(
              scene.filleted ?? scene.box,
              FILLET_BODY_ID,
            ),
          };
        })
        .then(
          () => {
            counters.settled += 1;
            writeSurface();
            const visible = coordinator.visible();
            if (visible !== null) {
              onApplied({ view: visible.state, revision: visible.revision });
            }
          },
          (failure: unknown) => {
            counters.settled += 1;
            if (failure instanceof WorkerRequestFailure) {
              const code = failure.error.data?.kernelCode;
              errorText =
                typeof code === "string"
                  ? `${code}: ${failure.error.message}`
                  : failure.error.message;
            } else {
              errorText =
                failure instanceof Error ? failure.message : String(failure);
            }
            writeSurface();
          },
        );
    },
    dispose(): void {
      boot.dispose();
    },
  };
}

export function OcctFilletFixturePage(): ReactElement {
  const [applied, setApplied] = useState<AppliedFilletView | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null);
  const [radius, setRadius] = useState(FILLET_DEFAULT_RADIUS_MM);
  const [booted, setBooted] = useState(false);
  const sessionRef = useRef<OcctFilletSession | null>(null);

  useEffect(() => {
    const session = bootOcctFilletSession((appliedView) => {
      setApplied(appliedView);
    });
    sessionRef.current = session;
    setBooted(true);
    session.dispatch({ edgeOrdinal: null, radiusMm: null });
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
  }, []);

  const anchors = useMemo(
    () => (applied === null ? "" : edgeAnchorSurface(applied.view.scene)),
    [applied],
  );

  const stage =
    applied === null || applied.view.scene.filleted === null
      ? "picking"
      : "filleted";

  /** Selects the nearest anchor edge, or clears the pick when none is near. */
  const pickEdgeAt = useCallback(
    (clientX: number, clientY: number, viewport: DOMRect): void => {
      if (applied === null || applied.view.scene.filleted !== null) return;
      const x = clientX - viewport.left;
      const y = clientY - viewport.top;
      const camera = extrudeCamera(applied.view.scene.box.bounds);
      let best: { ordinal: number; distance: number } | null = null;
      for (const edge of applied.view.scene.edges) {
        const screen = renderCameraScreenPoint(
          camera,
          edge.centroidMm,
          VIEWPORT_CSS_WIDTH,
          VIEWPORT_CSS_HEIGHT,
        );
        const distance = Math.hypot(screen[0] - x, screen[1] - y);
        if (
          distance <= EDGE_PICK_RADIUS_PX &&
          (best === null || distance < best.distance)
        ) {
          best = { ordinal: edge.ordinal, distance };
        }
      }
      const picked = best === null ? null : best.ordinal;
      setSelectedEdge(picked);
      document
        .getElementById("occt-fillet-root")
        ?.setAttribute(
          "data-selected-edge",
          picked === null ? "" : String(picked),
        );
    },
    [applied],
  );

  const applyFillet = useCallback((): void => {
    if (sessionRef.current === null || selectedEdge === null) return;
    sessionRef.current.dispatch({
      edgeOrdinal: selectedEdge,
      radiusMm: radius,
    });
  }, [radius, selectedEdge]);

  const selectedEdgeLength =
    applied === null || selectedEdge === null
      ? null
      : (applied.view.scene.edges.find((edge) => edge.ordinal === selectedEdge)
          ?.lengthMm ?? null);

  return (
    <div
      id="occt-fillet-root"
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      data-dispatched="0"
      data-settled="0"
      data-in-flight="0"
      data-current-revision="0"
      data-applied-revision=""
      data-volume=""
      data-volume-exact=""
      data-stage={stage}
      data-selected-edge={selectedEdge === null ? "" : String(selectedEdge)}
      data-edge-anchors={anchors}
      data-error=""
    >
      <div>
        <h1 className="text-lg font-semibold">Phase 26.5 Fillet Fixture</h1>
        <p className="text-muted-foreground text-sm">
          Real OpenCascade worker: box → <code>solid.topology</code> snapshot →
          pick an edge in the viewport (the anchors ARE the snapshot&apos;s edge
          centroids, projected through the scene camera) →{" "}
          <code>solid.fillet</code> by that snapshot ordinal → measure. The
          kernel&apos;s structured failures surface verbatim; picking pauses
          once a fillet is shown (the filleted solid has different edges).
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-64 shrink-0 space-y-4">
          <label className="block text-sm" htmlFor="param-fillet-radius">
            <span className="mb-1 block font-medium">radius (mm)</span>
            <input
              id="param-fillet-radius"
              className="border-input bg-background w-full rounded border px-2 py-1 font-mono"
              type="number"
              min={0.5}
              step={0.5}
              disabled={!booted}
              value={radius}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (Number.isFinite(parsed) && parsed > 0) {
                  setRadius(parsed);
                }
              }}
            />
          </label>
          <button
            id="fillet-apply"
            type="button"
            className="border-input bg-background rounded border px-3 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!booted || selectedEdge === null}
            onClick={applyFillet}
          >
            Fillet selected edge
          </button>
          <ul className="space-y-1 font-mono text-xs">
            <li>
              status = <span id="occt-fillet-status">boot</span>
            </li>
            <li>
              volume = <span id="occt-fillet-volume">…</span>
              {"\u00A0"}mm³ (exact band)
            </li>
            <li>
              stage = <span id="occt-fillet-stage">{stage}</span>
            </li>
            <li>
              selected edge ={" "}
              <span id="occt-fillet-selected-edge">
                {selectedEdge === null ? "none" : String(selectedEdge)}
              </span>
              {selectedEdgeLength === null
                ? ""
                : ` (${selectedEdgeLength.toFixed(3)} mm)`}
            </li>
            <li>
              edges in snapshot ={" "}
              <span id="occt-fillet-edge-count">
                {applied === null
                  ? "…"
                  : String(applied.view.scene.edges.length)}
              </span>
            </li>
            <li data-testid="occt-fillet-error" className="text-red-500">
              <span id="occt-fillet-error" />
            </li>
          </ul>
        </div>
        <div
          id="occt-fillet-viewport"
          className="h-[520px] w-[800px] shrink-0 overflow-hidden border"
          onPointerDown={(event) => {
            const viewport = event.currentTarget.getBoundingClientRect();
            pickEdgeAt(event.clientX, event.clientY, viewport);
          }}
        >
          {applied === null ? (
            <div className="flex h-full items-center justify-center text-sm">
              booting the OpenCascade worker…
            </div>
          ) : (
            <CadScene
              projection={applied.view.render.projection}
              regeneration={applied.revision}
              onSettled={() => {
                document
                  .getElementById("occt-fillet-root")
                  ?.setAttribute(
                    "data-cad-rendered-volume",
                    settledVolumeOf(applied.view).toFixed(3),
                  );
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
