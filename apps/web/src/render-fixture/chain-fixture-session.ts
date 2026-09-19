/**
 * The chain workbench's worker session (Phase 26 phase-level): the OCCT
 * worker hosting the WHOLE cross-feature chain, on the exact hosting
 * pattern of the shared render fixture session and the /worker-fillet
 * fixture — the package's web worker entry (`occt-worker-entry.ts`, the
 * ~22 MB pinned OpenCascade WASM), the crash-settling `bootWorkerChannel`,
 * `createStaleResultCoordinator` (every apply is a fresh dispatch,
 * newest-wins; a FAILED dispatch never becomes visible, so the
 * last-known-valid scene stays up).
 *
 * ## Machine surface (settle protocol parity)
 *
 * Writes the shared settle attributes on the root (`data-dispatched`,
 * `data-settled`, `data-in-flight`, `data-current-revision`,
 * `data-applied-revision`, `data-volume`, the full-precision twin
 * `data-volume-exact`, `data-error`) plus the status text. The session
 * applies a settled chain scene through `onApplied` (the visible scene —
 * the newest stage's solid — plus its revision) and reports a stage-
 * attributed failure through `onStageFailure` (the session itself writes
 * the structured `code: message` text to the error surface, the fillet
 * fixture's form).
 */

import {
  createStaleResultCoordinator,
  bootWorkerChannel,
  WorkerRequestFailure,
} from "@slopcad/cad-kernel";
import type { PlateRenderState } from "./plate-render-scene";
import type {
  ChainScene,
  ChainSceneRequest,
} from "../worker-fixture/chain-scene";

import { extrudeRenderState } from "./plate-render-scene";
import {
  ChainStageFailure,
  computeChainScene,
} from "../worker-fixture/chain-scene";

/** Where the booted session writes its machine-readable settle surface. */
interface ChainSurfaceTargets {
  /** The element receiving the `data-*` settle attributes. */
  readonly rootId: string;
  /** Text surfaces; each is updated when present. */
  readonly statusId?: string;
  readonly volumeId?: string;
  readonly errorId?: string;
}

/** The wired session a booted chain fixture exposes. */
export interface ChainFixtureSession {
  /** Dispatches one full chain computation (extrude → holes → fillets). */
  dispatch(request: ChainSceneRequest, bodyId: string): void;
  /** Settles the channel and terminates the worker. */
  dispose(): void;
}

/** The applied scene view: the render state plus its chain scene data. */
export interface AppliedChainScene {
  readonly render: PlateRenderState;
  readonly scene: ChainScene;
  readonly revision: number;
}

/**
 * The solid a chain scene rendered: the newest stage the document asked
 * for (filleted → holed → extruded) — the visible-scene rule.
 */
export function renderedMeasurementOf(
  scene: ChainScene,
): ChainScene["extruded"] {
  return scene.filleted ?? scene.holed ?? scene.extruded;
}

/**
 * Boots the chain workbench's OCCT worker session (client-only, called
 * from an effect). `onApplied` receives every applied chain scene (in
 * application order, newest-wins); `onStageFailure` receives every
 * stage-attributed failure of a still-current dispatch.
 */
export function bootChainFixtureSession(
  targets: ChainSurfaceTargets,
  onApplied: (applied: AppliedChainScene) => void,
  onStageFailure: (failure: ChainStageFailure) => void,
): ChainFixtureSession {
  let errorText = "";
  // The crash-settling boot (Phase 35 hardening): a dead thread settles
  // in-flight requests (worker/transport-closed) instead of hanging, and
  // the crash lands on the same error surface as stage failures.
  const boot = bootWorkerChannel(
    new Worker(
      new URL("../worker-fixture/occt-worker-entry.ts", import.meta.url),
      {
        type: "module",
      },
    ),
    (failure) => {
      errorText = `worker channel failed (${failure.kind}): ${failure.message}`;
      writeSurface();
    },
  );
  const coordinator = createStaleResultCoordinator<AppliedChainScene>({
    client: boot.client,
  });
  const counters = { dispatched: 0, settled: 0 };

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
      const volume =
        visible === null
          ? null
          : renderedMeasurementOf(visible.state.scene).volume;
      root.setAttribute(
        "data-volume",
        volume === null ? "" : volume.toFixed(3),
      );
      root.setAttribute(
        "data-volume-exact",
        volume === null ? "" : String(volume),
      );
      root.setAttribute("data-error", errorText);
    }
    const status =
      inFlight > 0 ? "computing" : errorText === "" ? "idle" : "failed";
    const volume =
      visible === null
        ? "…"
        : renderedMeasurementOf(visible.state.scene).volume.toFixed(3);
    if (targets.statusId !== undefined) setText(targets.statusId, status);
    if (targets.volumeId !== undefined) setText(targets.volumeId, volume);
    if (targets.errorId !== undefined) setText(targets.errorId, errorText);
  }

  return {
    dispatch(request: ChainSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) => {
          const scene = await computeChainScene(context, request);
          return {
            scene,
            render: extrudeRenderState(renderedMeasurementOf(scene), bodyId),
            revision: context.revision,
          };
        })
        .then(
          () => {
            counters.settled += 1;
            writeSurface();
            const visible = coordinator.visible();
            if (visible !== null) {
              onApplied(visible.state);
            }
          },
          (failure: unknown) => {
            counters.settled += 1;
            if (failure instanceof ChainStageFailure) {
              errorText = failure.surfaceText();
              onStageFailure(failure);
            } else if (failure instanceof WorkerRequestFailure) {
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

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = text;
}
