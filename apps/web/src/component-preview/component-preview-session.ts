/**
 * The component preview pipeline (Phase 32): a reusable CAD component
 * built by the REAL Manifold kernel inside the module worker — the same
 * `solid.*` operation vocabulary every fixture session speaks — through
 * `@slopcad/cad-components`' context kernel (the package's public
 * worker-protocol adapter), then projected into the renderer-neutral
 * {@link RenderProjection} under the component's own preview body ids.
 *
 * Everything here is a public-surface composition: the component's
 * definition (its serialized metadata), `createContextKernel` over the
 * coordinator's {@link ComputationContext}, and cad-core's
 * `projectTessellation`. The camera is DATA derived from the measured
 * assembly bounds (the render fixture's discipline: a fixed home-view
 * direction at a bounds-proportional distance), so identical builds
 * always yield identical projection bytes — the settled preview is
 * byte-reproducible.
 *
 * ## Assembly seating (the consumer's datum)
 *
 * Components build in their own local frames. A component whose build is
 * an assembly (the enclosure's shell + plug lid) declares its bodies in
 * seated order; this module seats each body the component's public
 * helpers place it at — the enclosure's lid rides the rim
 * (`seatedLidZMm`) centered in the cavity (wall + half the fit
 * clearance). Single-body components seat at the origin.
 */

import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type RenderBounds,
  type RenderCamera,
  type RenderProjection,
} from "@slopcad/cad-core";
import type { ComputationContext, KernelBounds } from "@slopcad/cad-kernel";
import {
  createStaleResultCoordinator,
  bootWorkerChannel,
} from "@slopcad/cad-kernel";
import {
  createContextKernel,
  seatedLidOffsetMm,
  type CadComponent,
  type ComponentBuildBody,
  type ComponentParameterValues,
} from "@slopcad/cad-components";
import { componentAnalyticVolumesMm3 } from "@slopcad/cad-components/component-fixtures";

/** The fixed view direction of the preview camera (the render fixtures'
 * home view: +x, −y, +z octant, z-up), normalized once. */
const PREVIEW_EYE_DIRECTION: readonly [number, number, number] = (() => {
  const v: readonly [number, number, number] = [29, -40, 42];
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
})();

/** One rendered body's preview data: identity, measurement, projection. */
export interface ComponentPreviewBody {
  readonly name: string;
  readonly bodyId: string;
  readonly volumeMm3: number;
  readonly bounds: KernelBounds;
}

/** What the preview page renders and measures for one component build. */
export interface ComponentPreviewState {
  readonly componentId: string;
  readonly values: ComponentParameterValues;
  readonly bodies: readonly ComponentPreviewBody[];
  /**
   * The seated assembly's union bounds (each body's RAW kernel-measured
   * bounds plus its seating offset) — the same extent the camera frames.
   * The bounds readout reports THIS, not a re-union of the raw per-body
   * bounds, so the "bounds = X × Y × Z mm" line agrees with the seated
   * geometry actually rendered (the review fix for the readout
   * disagreeing with the projection).
   */
  readonly assemblyBounds: RenderBounds;
  /** The sum of the bodies' kernel-measured volumes. */
  readonly totalVolumeMm3: number;
  /** The analytic-truth total (the fixtures' closed forms at `values`). */
  readonly expectedVolumeMm3: number;
  readonly triangles: number;
  readonly projection: RenderProjection;
}

/** The analytic total of `componentId` at `values` (the fixtures' truth). */
export function analyticTotalVolumeMm3(
  componentId: string,
  values: ComponentParameterValues,
): number {
  const perBody = componentAnalyticVolumesMm3(componentId, values);
  if (perBody === undefined) return 0;
  return perBody.reduce((sum, volume) => sum + volume, 0);
}

/**
 * The seated placement of one body of `componentId` at `values`, in the
 * assembly frame: the enclosure's lid rides the shell's rim centered in
 * the cavity (its own public seating datum); every other body seats at
 * its built position.
 */
function seatedOffsetMm(
  componentId: string,
  body: ComponentBuildBody,
  values: ComponentParameterValues,
): readonly [number, number, number] {
  if (componentId === "electronics-enclosure" && body.name === "lid") {
    return seatedLidOffsetMm(values);
  }
  return [0, 0, 0];
}

/**
 * The union bounds of every SEATED body: each body's raw kernel-measured
 * bounds offset by its seating placement — the assembly extent the
 * camera frames and the bounds readout reports. Pure function of the
 * measurements and offsets, so identical builds always agree.
 */
export function assemblyBounds(
  bodies: readonly ComponentPreviewBody[],
  offsets: readonly (readonly [number, number, number])[],
): RenderBounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const [index, body] of bodies.entries()) {
    const offset = offsets[index] ?? [0, 0, 0];
    minX = Math.min(minX, body.bounds.min[0] + offset[0]);
    minY = Math.min(minY, body.bounds.min[1] + offset[1]);
    minZ = Math.min(minZ, body.bounds.min[2] + offset[2]);
    maxX = Math.max(maxX, body.bounds.max[0] + offset[0]);
    maxY = Math.max(maxY, body.bounds.max[1] + offset[1]);
    maxZ = Math.max(maxZ, body.bounds.max[2] + offset[2]);
  }
  return { max: [maxX, maxY, maxZ], min: [minX, minY, minZ] };
}

/**
 * The preview camera, derived from the seated assembly's bounds: the eye
 * sits on the fixed home-view direction at 2.2× the bounds' largest
 * extent from the bounds centre (the render fixture's framing
 * proportion). Pure function of the measurements, so identical solids
 * always yield identical projections.
 */
export function previewCamera(bounds: RenderBounds): RenderCamera {
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const extent = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    5,
  );
  const distance = 2.2 * extent;
  return {
    kind: "perspective",
    position: [
      center[0] + PREVIEW_EYE_DIRECTION[0] * distance,
      center[1] + PREVIEW_EYE_DIRECTION[1] * distance,
      center[2] + PREVIEW_EYE_DIRECTION[2] * distance,
    ],
    target: center,
    up: [0, 0, 1],
    fovDeg: 40,
  };
}

/** The "X × Y × Z" extents text of an assembly's bounds, in millimetres. */
function boundsExtentTextMm(bounds: RenderBounds): string {
  return `${(bounds.max[0] - bounds.min[0]).toFixed(3)} × ${(bounds.max[1] - bounds.min[1]).toFixed(3)} × ${(bounds.max[2] - bounds.min[2]).toFixed(3)}`;
}

/**
 * The preview state's bounds readout: the SEATED assembly's extents — the
 * same union the camera frames — never a re-union of the raw per-body
 * kernel bounds (which would ignore the seating offsets and disagree
 * with the rendered geometry, e.g. the enclosure lid's below-origin
 * bosses inflating the reported z extent).
 */
export function previewBoundsReadoutMm(state: ComponentPreviewState): string {
  return boundsExtentTextMm(state.assemblyBounds);
}

/** Shifts a tessellation's positions by a world offset (rigid placement). */
function offsetTessellation(
  tessellation: {
    readonly positions: readonly number[];
    readonly indices: readonly number[];
    readonly normals?: readonly number[];
  },
  offset: readonly [number, number, number],
) {
  if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) {
    return tessellation;
  }
  const positions: number[] = [];
  for (let index = 0; index < tessellation.positions.length; index += 3) {
    const x = tessellation.positions[index];
    const y = tessellation.positions[index + 1];
    const z = tessellation.positions[index + 2];
    if (x === undefined || y === undefined || z === undefined) break;
    positions.push(x + offset[0], y + offset[1], z + offset[2]);
  }
  return {
    indices: tessellation.indices,
    ...(tessellation.normals !== undefined
      ? { normals: tessellation.normals }
      : {}),
    positions,
  };
}

function projectionFailure(message: string): Error {
  return new Error(`Component preview rejected: ${message}`);
}

/**
 * Builds `component` at `values` in the worker and derives its preview
 * state: per-body kernel measurements, the analytic expected total, and
 * the seated-assembly projection under the definition's preview body ids.
 * Deterministic: the same component and values always yield the same
 * projection bytes.
 */
export async function computeComponentPreview(
  context: ComputationContext,
  component: CadComponent,
  values: ComponentParameterValues,
): Promise<ComponentPreviewState> {
  const kernel = createContextKernel(context);
  const build = await component.build(kernel, values);
  if (!build.ok) {
    throw projectionFailure(`${build.error.code}: ${build.error.message}`);
  }

  const bodies: ComponentPreviewBody[] = [];
  const offsets: (readonly [number, number, number])[] = [];
  const projectedObjects: ReturnType<typeof projectTessellation>[] = [];
  let triangles = 0;
  for (const body of build.value.bodies) {
    const volume = await kernel.volume(body.solid);
    if (!volume.ok) throw projectionFailure(volume.error.message);
    const bounds = await kernel.bounds(body.solid);
    if (!bounds.ok) throw projectionFailure(bounds.error.message);
    const tessellation = await kernel.tessellate(body.solid);
    if (!tessellation.ok) throw projectionFailure(tessellation.error.message);
    const offset = seatedOffsetMm(component.definition.id, body, values);
    const object = projectTessellation(
      createBodyId(body.bodyId),
      offsetTessellation(tessellation.value, offset),
    );
    if (!object.ok) throw projectionFailure(object.error.message);
    triangles += tessellation.value.indices.length / 3;
    bodies.push({
      bodyId: body.bodyId,
      bounds: bounds.value,
      name: body.name,
      volumeMm3: volume.value,
    });
    offsets.push(offset);
    projectedObjects.push(object);
  }

  const bounds = assemblyBounds(bodies, offsets);
  const projection = createRenderProjection(
    projectedObjects.map((object) => {
      if (!object.ok) throw projectionFailure(object.error.message);
      return object.value;
    }),
    previewCamera(bounds),
  );
  if (!projection.ok) throw projectionFailure(projection.error.message);

  return {
    assemblyBounds: bounds,
    bodies,
    componentId: component.definition.id,
    expectedVolumeMm3: analyticTotalVolumeMm3(component.definition.id, values),
    projection: projection.value,
    totalVolumeMm3: bodies.reduce((sum, body) => sum + body.volumeMm3, 0),
    triangles,
    values,
  };
}

// ---------------------------------------------------------------------------
// The worker session boot (the fixture sessions' discipline)
// ---------------------------------------------------------------------------

/** Where the booted preview session writes its machine-readable surface. */
export interface ComponentPreviewSurface {
  /** The element receiving the settle `data-*` attributes. */
  readonly rootId: string;
  /** Text surfaces; each is updated when present. */
  readonly statusId: string;
  readonly volumeId: string;
  readonly expectedVolumeId: string;
  readonly boundsId: string;
  readonly trianglesId: string;
  readonly errorId: string;
}

/** The wired preview session a booted page exposes. */
export interface ComponentPreviewSession {
  /** Dispatches one component build at `values` through the worker. */
  dispatch(component: CadComponent, values: ComponentParameterValues): void;
  /** Settles the channel and terminates the worker. */
  dispose(): void;
}

/**
 * Boots the preview's worker session (client-only, called from an
 * effect): the real Manifold kernel in the module worker behind the
 * stale-result coordinator, writing the settle surface into the page's
 * named elements. `onApplied` receives every preview state that became
 * the visible one, newest-wins.
 */
export function bootComponentPreviewSession(
  surface: ComponentPreviewSurface,
  onApplied: (state: ComponentPreviewState) => void,
): ComponentPreviewSession {
  let errorText = "";
  // The crash-settling boot (Phase 35 hardening): a dead thread settles
  // in-flight requests (worker/transport-closed) instead of hanging, and
  // the crash lands on the same error surface as build failures.
  const boot = bootWorkerChannel(
    new Worker(
      new URL("../worker-fixture/manifold-worker-entry.ts", import.meta.url),
      { type: "module" },
    ),
    (failure) => {
      errorText = `worker channel failed (${failure.kind}): ${failure.message}`;
      writeSurface();
    },
  );
  const coordinator = createStaleResultCoordinator<ComponentPreviewState>({
    client: boot.client,
  });
  const counters = { dispatched: 0, settled: 0 };

  function setText(id: string, text: string): void {
    const element = document.getElementById(id);
    if (element !== null) element.textContent = text;
  }

  /** Writes the whole coordinator-driven state surface in one pass. */
  function writeSurface(): void {
    const visible = coordinator.visible();
    const inFlight = counters.dispatched - counters.settled;
    const root = document.getElementById(surface.rootId);
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
        visible === null ? "" : visible.state.totalVolumeMm3.toFixed(3),
      );
      root.setAttribute(
        "data-expected-volume",
        visible === null ? "" : visible.state.expectedVolumeMm3.toFixed(3),
      );
      root.setAttribute("data-error", errorText);
    }
    const status = inFlight > 0 ? "computing" : "idle";
    if (visible === null) {
      setText(surface.statusId, status);
      setText(surface.volumeId, "…");
      setText(surface.expectedVolumeId, "…");
      setText(surface.boundsId, "…");
      setText(surface.trianglesId, "…");
    } else {
      setText(surface.statusId, status);
      setText(surface.volumeId, visible.state.totalVolumeMm3.toFixed(3));
      setText(
        surface.expectedVolumeId,
        visible.state.expectedVolumeMm3.toFixed(3),
      );
      // The readout reports the SEATED assembly's extents (the same union
      // the camera frames), not a re-union of the raw per-body bounds.
      setText(surface.boundsId, previewBoundsReadoutMm(visible.state));
      setText(surface.trianglesId, String(visible.state.triangles));
    }
    setText(surface.errorId, errorText);
  }

  return {
    dispatch(component, values) {
      counters.dispatched += 1;
      writeSurface();
      coordinator
        .update((context) =>
          computeComponentPreview(context, component, values),
        )
        .then(
          (outcome) => {
            counters.settled += 1;
            if (outcome.outcome === "applied") {
              onApplied(outcome.result);
            }
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
    dispose() {
      boot.dispose();
    },
  };
}
