/**
 * Shared boot plumbing for the browser fixtures (`/render` and the Phase 14
 * `/workbench`): the stale-result-coordinated worker session and the
 * face-anchor surface, both deterministic and identical for identical
 * inputs. Extracted verbatim from the Phase 13 fixture page so the Phase 14
 * workbench can reuse the same pipeline without duplicating it.
 */

import type { SelectionReference } from "@slopcad/cad-core";
import {
  groupSyntheticFaces,
  serializeDimensionalValue,
  serializeSelectionReference,
  syntheticFaceAnchor,
  syntheticFaceMeanNormal,
  type ToolCompletion,
} from "@slopcad/cad-core";
import {
  createStaleResultCoordinator,
  createWebWorkerTransport,
  createWorkerClient,
} from "@slopcad/cad-kernel";
import type { WorkerClient } from "@slopcad/cad-kernel";
import { renderCameraScreenPoint } from "@slopcad/cad-r3f";
import type {
  ExtrudeSceneRequest,
  HoleSceneRequest,
  PlateMeasurement,
  RevolveSceneRequest,
} from "../worker-fixture/plate-scene-extra";

import {
  computePlateRenderState,
  extrudeRenderState,
  type PlateRenderState,
} from "./plate-render-scene";
import { computeExtrudeScene } from "../worker-fixture/extrude-scene";
import { computeRevolveScene } from "../worker-fixture/revolve-scene";
import { computeHoleScene } from "../worker-fixture/hole-scene";

/** The fixtures' fixed viewport, in CSS pixels — the scene camera spec is
 * authored for exactly this size (and the scene runs at dpr 1), which is
 * what makes the camera spec's screen mapping constant. */
const VIEWPORT_CSS_WIDTH = 800;
const VIEWPORT_CSS_HEIGHT = 520;

/** The wired session a booted fixture exposes. */
export interface RenderFixtureSession {
  /** Records a parameter change and dispatches the plate computation. */
  dispatch(holeDiameterMm: number): void;
  /**
   * Dispatches the Phase 26.1 extrude computation: the REAL kernel executes
   * `solid.extrude` on the sketch-resolved profile in the worker, and the
   * settled solid's measurement + projection become the visible scene.
   */
  dispatchExtrude(request: ExtrudeSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 26.2 revolve computation: the REAL kernel executes
   * `solid.revolve` on the sketch-resolved profile about the pinned axis in
   * the worker, and the settled solid's measurement + projection become the
   * visible scene (the same bounds-derived camera the extrude scene uses).
   */
  dispatchRevolve(request: RevolveSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 26.10 hole computation: the REAL kernel composes
   * the base extrusion, one planned tool per hole, and the subtract in the
   * worker, and the settled solid's measurement + projection become the
   * visible scene (the same bounds-derived camera the extrude scene uses).
   */
  dispatchHole(request: HoleSceneRequest, bodyId: string): void;
  /** Settles the channel and terminates the worker. */
  dispose(): void;
}

/** Where the booted session writes its machine-readable settle surface. */
interface FixtureSurfaceTargets {
  /** The element receiving the `data-*` settle attributes. */
  readonly rootId: string;
  /** Text surfaces; each is updated when present. */
  readonly statusId?: string;
  readonly volumeId?: string;
  readonly boundsId?: string;
  readonly trianglesId?: string;
  readonly revisionsId?: string;
  readonly errorId?: string;
}

/** One-decimal rounding for screen points (sub-pixel precision is noise). */
function round1(value: number): number {
  return Number(value.toFixed(1));
}

/** Three-decimal rounding for normal metadata. */
function round3(value: number): number {
  return Number(value.toFixed(3));
}

/** Bounds rendered as extents, the fixtures' `30.000 × 20.000 × 10.000` form. */
function formatBoundsExtents(measurement: PlateMeasurement): string {
  const { min, max } = measurement.bounds;
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    .map((extent) => extent.toFixed(3))
    .join(" × ");
}

/**
 * Canonical JSON of a selection reference (fixed key order, so the DOM
 * surface is byte-stable across renders).
 */
export function selectionJson(reference: SelectionReference): string {
  return JSON.stringify(serializeSelectionReference(reference));
}

/**
 * Canonical JSON of a tool completion: dimensional values and transactions
 * through their canonical serializers, so the surface is stable data.
 */
export function completionJson(completion: ToolCompletion): string {
  const { detail } = completion;
  return JSON.stringify({
    toolId: completion.toolId,
    detail:
      detail.kind === "measurement"
        ? {
            kind: detail.kind,
            distance: serializeDimensionalValue(detail.distance),
            from: detail.from,
            to: detail.to,
          }
        : detail.kind === "commands"
          ? { kind: detail.kind, summary: detail.summary }
          : { kind: detail.kind },
  });
}

/**
 * The face-anchor map for the applied projection: per rendered object and
 * synthetic face, the CSS-pixel anchor point and the face's mean normal.
 * Pure function of the render state — deterministic, so tests can rely on
 * identical anchors across runs of the same parameters.
 */
export function faceAnchorSurface(renderState: PlateRenderState): string {
  const anchors: Record<
    string,
    {
      readonly point: readonly [number, number];
      readonly normal: readonly [number, number, number] | null;
    }
  > = {};
  for (const object of renderState.projection.objects) {
    const grouping = groupSyntheticFaces(object);
    for (const face of grouping.faces) {
      const world = syntheticFaceAnchor(object, grouping, face.index);
      // Closed curved faces (e.g. the bore wall) have no single normal —
      // the cad-core helper reports null and the surface publishes it
      // verbatim instead of a fabricated direction.
      const meanNormal = syntheticFaceMeanNormal(object, grouping, face.index);
      const screen = renderCameraScreenPoint(
        renderState.projection.camera,
        world,
        VIEWPORT_CSS_WIDTH,
        VIEWPORT_CSS_HEIGHT,
      );
      anchors[`${object.bodyId ?? object.id}/${String(face.index)}`] = {
        point: [round1(screen[0]), round1(screen[1])],
        normal:
          meanNormal === null
            ? null
            : [
                round3(meanNormal[0]),
                round3(meanNormal[1]),
                round3(meanNormal[2]),
              ],
      };
    }
  }
  return JSON.stringify(anchors);
}

/**
 * Boots a fixture's worker session (client-only, called from an effect).
 * `onApplied` receives every render state that became the visible one —
 * in application order, newest-wins through the stale-result coordinator —
 * together with the revision identity the domain selection state must
 * stand at.
 */
export function bootRenderFixtureSession(
  targets: FixtureSurfaceTargets,
  onApplied: (state: PlateRenderState, revision: number) => void,
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
    const root = document.getElementById(targets.rootId);
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
    const status = inFlight > 0 ? "computing" : "idle";
    const volume =
      visible === null ? "…" : visible.state.measurement.volume.toFixed(3);
    if (targets.statusId !== undefined) setText(targets.statusId, status);
    if (targets.volumeId !== undefined) setText(targets.volumeId, volume);
    if (targets.boundsId !== undefined) {
      setText(
        targets.boundsId,
        visible === null ? "…" : formatBoundsExtents(visible.state.measurement),
      );
    }
    if (targets.trianglesId !== undefined) {
      setText(
        targets.trianglesId,
        visible === null ? "…" : String(visible.state.measurement.triangles),
      );
    }
    if (targets.revisionsId !== undefined) {
      setText(
        targets.revisionsId,
        visible === null
          ? `—/${coordinator.currentRevision()}`
          : `${visible.revision}/${coordinator.currentRevision()}`,
      );
    }
    if (targets.errorId !== undefined) setText(targets.errorId, errorText);
  }

  /** Shared settle path of both dispatch forms. */
  function settle(): void {
    counters.settled += 1;
    writeSurface();
    // The coordinator's visible state is the authority (a superseded
    // computation settles without ever becoming visible).
    const visible = coordinator.visible();
    if (visible !== null) onApplied(visible.state, visible.revision);
  }

  return {
    dispatch(holeDiameterMm: number): void {
      counters.dispatched += 1;
      writeSurface();
      coordinator
        .update((context) => computePlateRenderState(context, holeDiameterMm))
        .then(settle, (failure: unknown) => {
          counters.settled += 1;
          errorText =
            failure instanceof Error ? failure.message : String(failure);
          writeSurface();
        });
    },
    dispatchExtrude(request: ExtrudeSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computeExtrudeScene(context, request),
            bodyId,
          ),
        )
        .then(settle, (failure: unknown) => {
          counters.settled += 1;
          errorText =
            failure instanceof Error ? failure.message : String(failure);
          writeSurface();
        });
    },
    dispatchRevolve(request: RevolveSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computeRevolveScene(context, request),
            bodyId,
          ),
        )
        .then(settle, (failure: unknown) => {
          counters.settled += 1;
          errorText =
            failure instanceof Error ? failure.message : String(failure);
          writeSurface();
        });
    },
    dispatchHole(request: HoleSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(await computeHoleScene(context, request), bodyId),
        )
        .then(settle, (failure: unknown) => {
          counters.settled += 1;
          errorText =
            failure instanceof Error ? failure.message : String(failure);
          writeSurface();
        });
    },
    dispose(): void {
      client.close();
      worker.terminate();
    },
  };
}

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = text;
}
