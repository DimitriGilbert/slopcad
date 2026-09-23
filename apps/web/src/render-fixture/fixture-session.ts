/**
 * Shared boot plumbing for the browser fixtures (`/render` and the Phase 14
 * `/workbench`): the stale-result-coordinated worker session and the
 * face-anchor surface, both deterministic and identical for identical
 * inputs. Extracted verbatim from the Phase 13 fixture page so the Phase 14
 * workbench can reuse the same pipeline without duplicating it.
 */

import type { SelectionReference } from "@slopcad/cad-core";
import {
  formatBoundsExtents,
  groupSyntheticFaces,
  serializeDimensionalValue,
  serializeSelectionReference,
  syntheticFaceAnchor,
  syntheticFaceMeanNormal,
  type ToolCompletion,
} from "@slopcad/cad-core";
import {
  createStaleResultCoordinator,
  bootWorkerChannel,
  WorkerRequestFailure,
} from "@slopcad/cad-kernel";
import { renderCameraScreenPoint } from "@slopcad/cad-r3f";
import type {
  ExtrudeSceneRequest,
  HoleSceneRequest,
  LoftSceneRequest,
  RevolveSceneRequest,
  SweepSceneRequest,
  PadSceneRequest,
} from "../worker-fixture/plate-scene-extra";
import type { HelixSceneRequest } from "../worker-fixture/helix-scene";
import type { ThreadSceneRequest } from "../worker-fixture/thread-scene";
import type { RibSceneRequest } from "../cad-workbench/rib";
import type {
  ScaleSceneRequest,
  ThickenSceneRequest,
} from "../cad-workbench/scale-thicken";
import type { SplitSceneRequest } from "../cad-workbench/split";
import type {
  MirrorSceneRequest,
  PatternFeatureSceneRequest,
  PatternPathSceneRequest,
} from "../cad-workbench/pattern";
import type { BooleanSceneRequest } from "../cad-workbench/boolean";
import type { MoveBodySceneRequest } from "../cad-workbench/move-body";
import type { SheetSceneRequest } from "../cad-workbench/surface-scene";

import {
  computePlateRenderState,
  type SectionDisplayRequest,
  extrudeRenderState,
  type PlateRenderState,
} from "./plate-render-scene";
import { computeExtrudeScene } from "../worker-fixture/extrude-scene";
import { computeRevolveScene } from "../worker-fixture/revolve-scene";
import { computeSweepScene } from "../worker-fixture/sweep-scene";
import { computeLoftScene } from "../worker-fixture/loft-scene";
import { computeHoleScene } from "../worker-fixture/hole-scene";
import { computePadScene } from "../worker-fixture/pad-scene";
import { computeHelixScene } from "../worker-fixture/helix-scene";
import { computeThreadScene } from "../worker-fixture/thread-scene";
import {
  computeRibScene,
  computeScaleScene,
  computeSplitScene,
  computeThickenScene,
} from "../worker-fixture/feature-richness-scenes";
import {
  computeMirrorScene,
  computePatternFeatureScene,
  computePatternPathScene,
} from "../worker-fixture/pattern-scene";
import {
  computeBooleanScene,
  computeMoveBodyScene,
} from "../worker-fixture/body-ops-scenes";
import {
  computeSheetScene,
  sheetRenderState,
} from "../worker-fixture/sheet-scene";

/** The fixtures' fixed viewport, in CSS pixels — the scene camera spec is
 * authored for exactly this size (and the scene runs at dpr 1), which is
 * what makes the camera spec's screen mapping constant. */
const VIEWPORT_CSS_WIDTH = 800;
const VIEWPORT_CSS_HEIGHT = 520;

/** The wired session a booted fixture exposes. */
export interface RenderFixtureSession {
  /**
   * Records a parameter change and dispatches the plate computation —
   * optionally cutting a section first (Phase 46): with a request the
   * settle carries the face measurements, and view mode swaps the
   * displayed body to the cut solid. Absent or `null` is the unsectioned
   * path, byte-unchanged.
   */
  dispatch(
    holeDiameterMm: number,
    section?: SectionDisplayRequest | null,
  ): void;
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
   * Dispatches the Phase 38 sweep computation: the REAL kernel executes
   * `solid.sweep` on the sketch-resolved profile along the mapped XZ path
   * in the worker, and the settled solid's measurement + projection become
   * the visible scene (the same bounds-derived camera the extrude scene
   * uses). On a kernel without the sweep capability the structured
   * `kernel/unsupported-operation` lands on the session's error surface.
   */
  dispatchSweep(request: SweepSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 38 loft computation: the REAL kernel executes
   * `solid.loft` on the ordered sketch-resolved sections at their stations
   * in the worker, and the settled solid's measurement + projection become
   * the visible scene. On a kernel without the loft capability the
   * structured `kernel/unsupported-operation` lands on the error surface.
   */
  dispatchLoft(request: LoftSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 40 helix computation: the REAL kernel executes
   * `solid.helixSweep` on the sketch-resolved meridian loop along the
   * analytic spine in the worker, and the settled solid's measurement +
   * projection become the visible scene. On a kernel without the helix
   * capability the structured `kernel/unsupported-operation` lands on the
   * error surface.
   */
  dispatchHelix(request: HelixSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 40 thread computation: the REAL kernel composes
   * the base extrusion, the planned ISO tool's `solid.helixSweep`, and
   * the subtract in the worker, and the settled solid's measurement +
   * projection become the visible scene. The cosmetic mode resolves to
   * the base alone.
   */
  dispatchThread(request: ThreadSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 41 rib computation: the REAL kernel composes the
   * base extrusion, the rib profile's symmetric half-thickness extrusion
   * pair, and their union in the worker (the no-op guard rides the
   * computation rejection), and the settled solid's measurement +
   * projection become the visible scene.
   */
  dispatchRib(request: RibSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 41 scale computation: the REAL kernel executes
   * the base extrusion and one `solid.transform` carrying the uniform
   * scale field in the worker. On a kernel without the transformScale
   * capability the structured `kernel/unsupported-operation` lands on the
   * error surface.
   */
  dispatchScale(request: ScaleSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 41 thicken computation: the REAL kernel executes
   * the base extrusion and one `solid.thicken` in the worker. On a kernel
   * without the thicken capability the structured
   * `kernel/unsupported-operation` lands on the error surface.
   */
  dispatchThicken(request: ThickenSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 49 sheet computation: the REAL kernel evaluates
   * the surface-family feature's rebuild plan in the worker — the base
   * patch through `solid.createSheet`, the sheet-consuming family through
   * `sheet.trim`/`sheet.thicken`/`sheet.knit`/`sheet.offset` — and the
   * settled body's measurement + projection become the visible scene (an
   * open shell renders BOTH sides). On a kernel without the surfaceOps
   * capability the structured `kernel/unsupported-operation` lands on the
   * error surface.
   */
  dispatchSheet(request: SheetSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 41 split computation: the REAL kernel composes
   * the base extrusion, the bridge's planned covering-box tool, and the
   * subtract in the worker (the both-ways post-condition rides the
   * computation rejection).
   */
  dispatchSplit(request: SplitSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 43 patternFeature computation: the REAL kernel
   * composes the base extrusion, the shared leg-grid planner's per-
   * instance transforms (skips dropped), and one union in the worker.
   */
  dispatchPatternFeature(
    request: PatternFeatureSceneRequest,
    bodyId: string,
  ): void;
  /**
   * Dispatches the Phase 43 patternPath computation: the REAL kernel
   * composes the base extrusion and the shared path-geometry walk's
   * per-station transforms (fixed or tangent-following) in the worker.
   */
  dispatchPatternPath(request: PatternPathSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 43 mirror computation: the REAL kernel executes
   * the shared `planDatumMirror` recipe on the base extrusion in the
   * worker (one union more when the merge option asks for it).
   */
  dispatchMirror(request: MirrorSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 44 boolean computation: the REAL kernel executes
   * the target and tool extrusions and one `solid.union`/`solid.subtract`/
   * `solid.intersect` in the worker (the no-op guards ride the computation
   * rejection), and the settled solid's measurement + projection become
   * the visible scene.
   */
  dispatchBoolean(request: BooleanSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 44 move-body computation: the REAL kernel
   * executes the base extrusion and one `solid.transform` carrying the
   * authored translation (and optional world-axis rotation) in the worker.
   * On a rotation-incapable kernel the structured refusal lands on the
   * error surface.
   */
  dispatchMoveBody(request: MoveBodySceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 26.10 hole computation: the REAL kernel composes
   * the base extrusion, one planned tool per hole, and the subtract in the
   * worker, and the settled solid's measurement + projection become the
   * visible scene (the same bounds-derived camera the extrude scene uses).
   */
  dispatchHole(request: HoleSceneRequest, bodyId: string): void;
  /**
   * Dispatches the Phase 39 pad computation: the REAL kernel composes the
   * base extrusion, the datum-anchored pad extrusion, and their union in
   * the worker, and the settled solid's measurement + projection become
   * the visible scene (the same bounds-derived camera the extrude scene
   * uses). This is the scene that makes "edit driving face — geometry
   * follows" measurable in the settle volume.
   */
  dispatchPad(request: PadSceneRequest, bodyId: string): void;
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
 *
 * `viewport` is the CSS-pixel size the anchors project into — the size of
 * the canvas the clicks land on. The scene camera consumes the LIVE canvas
 * aspect (R3F's `size`), so a caller whose canvas size differs from the
 * fixture's fixed 800×520 frame MUST pass the live size or every anchor
 * mis-projects by the aspect difference. Fixed-viewport fixtures omit it
 * and keep the authored frame (their canvas IS that size — byte-stable).
 */
export function faceAnchorSurface(
  renderState: PlateRenderState,
  viewport: { readonly width: number; readonly height: number } = {
    width: VIEWPORT_CSS_WIDTH,
    height: VIEWPORT_CSS_HEIGHT,
  },
): string {
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
        viewport.width,
        viewport.height,
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
 * The worker backend a fixture session boots. The default (and the boot
 * every established fixture and baseline pins) is the Manifold kernel; the
 * OCCT option exists for compositions whose feature vocabulary needs the
 * BREP-exact kernels — sweep and loft (Phase 38) are honest declines on
 * Manifold, so the sweep-capable complete-workbench route boots OCCT.
 */
export type FixtureSessionBackend = "manifold" | "occt";

/** The feature-backed scene kinds a dispatch can carry a verdict for. */
export type FeatureSceneKind =
  | "extrude"
  | "revolve"
  | "sweep"
  | "loft"
  | "helix"
  | "thread"
  | "boolean"
  | "moveBody"
  | "rib"
  | "scale"
  | "thicken"
  | "split"
  | "patternFeature"
  | "patternPath"
  | "mirror"
  | "hole"
  | "pad"
  | "sheet";

/**
 * One feature-backed scene dispatch's worker verdict — the seam a host uses
 * to map the KERNEL's build verdict into the feature's timeline status (the
 * document-data executor alone cannot know a kernel declined an operation).
 */
export type SceneDispatchOutcome =
  | {
      /** The worker built the scene's solid. */
      readonly ok: true;
      /** The scene that settled. */
      readonly scene: FeatureSceneKind;
      /** The dispatched feature's output body. */
      readonly bodyId: string;
    }
  | {
      /** The worker refused or failed the build. */
      readonly ok: false;
      /** The scene that failed. */
      readonly scene: FeatureSceneKind;
      /** The dispatched feature's output body. */
      readonly bodyId: string;
      /** The verbatim error-surface text (so a chip can never contradict it). */
      readonly text: string;
    };

/**
 * The failure text the session surfaces: the protocol code, the kernel
 * code when the failure carries one, then the message — the io page's
 * `workerErrorText` format, so a structured kernel decline (e.g. the
 * Manifold sweep's `kernel/unsupported-operation`) is machine-readable on
 * the error surface.
 */
function failureText(failure: unknown): string {
  if (failure instanceof WorkerRequestFailure) {
    const kernelCode = failure.error.data?.kernelCode;
    return kernelCode === undefined
      ? `${failure.error.code}: ${failure.error.message}`
      : `${failure.error.code} [${String(kernelCode)}]: ${failure.error.message}`;
  }
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * The structured outcome of one failed feature-scene dispatch: the error
 * surface's exact text (protocol code, bracketed kernel code, message)
 * riding verbatim — the host's timeline diagnostic repeats it word for
 * word, so the chip and the error surface can never disagree.
 */
function sceneDispatchFailure(
  scene: FeatureSceneKind,
  bodyId: string,
  failure: unknown,
): SceneDispatchOutcome {
  return {
    ok: false,
    scene,
    bodyId,
    text: failureText(failure),
  };
}

/** Options of {@link bootRenderFixtureSession}. */
export interface BootRenderFixtureSessionOptions {
  /**
   * The worker backend to boot; the default `"manifold"` is the
   * boot state every established baseline pins (byte-determinism).
   */
  readonly backend?: FixtureSessionBackend;
  /**
   * Receives every feature-backed scene dispatch's worker verdict —
   * success when the scene settles, the structured refusal when the
   * kernel declines (e.g. Manifold's `kernel/unsupported-operation` for
   * sweep/loft). The host maps the verdict onto the feature's timeline
   * status, so a refusal the error surface shows cannot hide behind a
   * "valid" chip (Phase 38's capability honesty).
   */
  readonly onSceneOutcome?: (outcome: SceneDispatchOutcome) => void;
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
  options: BootRenderFixtureSessionOptions = {},
): RenderFixtureSession {
  let errorText = "";
  // The crash-settling boot (Phase 35 hardening): a dead thread settles
  // in-flight requests (worker/transport-closed) instead of hanging, and
  // the crash lands on the same error surface as computation failures.
  // The worker URLs stay INLINE string literals per branch — the bundler
  // statically rewrites exactly that form into its worker chunks, so a
  // variable indirection here would silently break the worker emission.
  const backend = options.backend ?? "manifold";
  const boot = bootWorkerChannel(
    backend === "occt"
      ? new Worker(
          new URL("../worker-fixture/occt-worker-entry.ts", import.meta.url),
          { type: "module" },
        )
      : new Worker(
          new URL(
            "../worker-fixture/manifold-worker-entry.ts",
            import.meta.url,
          ),
          { type: "module" },
        ),
    (failure) => {
      errorText = `worker channel failed (${failure.kind}): ${failure.message}`;
      writeSurface();
    },
  );
  const coordinator = createStaleResultCoordinator<PlateRenderState>({
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
      root.setAttribute(
        "data-volume",
        visible === null ? "" : visible.state.measurement.volume.toFixed(3),
      );
      root.setAttribute("data-error", errorText);
    }
    const status =
      inFlight > 0 ? "computing" : errorText === "" ? "idle" : "failed";
    const volume =
      visible === null ? "…" : visible.state.measurement.volume.toFixed(3);
    if (targets.statusId !== undefined) setText(targets.statusId, status);
    if (targets.volumeId !== undefined) setText(targets.volumeId, volume);
    if (targets.boundsId !== undefined) {
      setText(
        targets.boundsId,
        visible === null
          ? "…"
          : formatBoundsExtents(visible.state.measurement.bounds),
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

  /** Reports one feature-backed dispatch's verdict (the timeline seam). */
  function settleWithVerdict(
    scene: FeatureSceneKind,
    bodyId: string,
  ): () => void {
    return () => {
      settle();
      options.onSceneOutcome?.({ ok: true, scene, bodyId });
    };
  }

  /** The failure path of one feature-backed dispatch, verdict included. */
  function failWithVerdict(
    scene: FeatureSceneKind,
    bodyId: string,
  ): (failure: unknown) => void {
    return (failure: unknown) => {
      counters.settled += 1;
      errorText = failureText(failure);
      writeSurface();
      options.onSceneOutcome?.(sceneDispatchFailure(scene, bodyId, failure));
    };
  }

  return {
    dispatch(
      holeDiameterMm: number,
      section?: SectionDisplayRequest | null,
    ): void {
      counters.dispatched += 1;
      // A new dispatch supersedes the previous failure's error text: the
      // error surface must reset on recovery, not stay write-once (the
      // chain sibling's discipline).
      errorText = "";
      writeSurface();
      coordinator
        .update((context) =>
          computePlateRenderState(context, holeDiameterMm, section ?? null),
        )
        .then(settle, (failure: unknown) => {
          counters.settled += 1;
          errorText = failureText(failure);
          writeSurface();
        });
    },
    dispatchExtrude(request: ExtrudeSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computeExtrudeScene(context, request),
            bodyId,
          ),
        )
        .then(
          settleWithVerdict("extrude", bodyId),
          failWithVerdict("extrude", bodyId),
        );
    },
    dispatchRevolve(request: RevolveSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computeRevolveScene(context, request),
            bodyId,
          ),
        )
        .then(
          settleWithVerdict("revolve", bodyId),
          failWithVerdict("revolve", bodyId),
        );
    },
    dispatchHole(request: HoleSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(await computeHoleScene(context, request), bodyId),
        )
        .then(
          settleWithVerdict("hole", bodyId),
          failWithVerdict("hole", bodyId),
        );
    },
    dispatchPad(request: PadSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(await computePadScene(context, request), bodyId),
        )
        .then(settleWithVerdict("pad", bodyId), failWithVerdict("pad", bodyId));
    },
    dispatchSweep(request: SweepSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(await computeSweepScene(context, request), bodyId),
        )
        .then(
          settleWithVerdict("sweep", bodyId),
          failWithVerdict("sweep", bodyId),
        );
    },
    dispatchLoft(request: LoftSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(await computeLoftScene(context, request), bodyId),
        )
        .then(
          settleWithVerdict("loft", bodyId),
          failWithVerdict("loft", bodyId),
        );
    },
    dispatchHelix(request: HelixSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(await computeHelixScene(context, request), bodyId),
        )
        .then(
          settleWithVerdict("helix", bodyId),
          failWithVerdict("helix", bodyId),
        );
    },
    dispatchThread(request: ThreadSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computeThreadScene(context, request),
            bodyId,
          ),
        )
        .then(
          settleWithVerdict("thread", bodyId),
          failWithVerdict("thread", bodyId),
        );
    },
    dispatchRib(request: RibSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(await computeRibScene(context, request), bodyId),
        )
        .then(settleWithVerdict("rib", bodyId), failWithVerdict("rib", bodyId));
    },
    dispatchScale(request: ScaleSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(await computeScaleScene(context, request), bodyId),
        )
        .then(
          settleWithVerdict("scale", bodyId),
          failWithVerdict("scale", bodyId),
        );
    },
    dispatchThicken(request: ThickenSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computeThickenScene(context, request),
            bodyId,
          ),
        )
        .then(
          settleWithVerdict("thicken", bodyId),
          failWithVerdict("thicken", bodyId),
        );
    },
    dispatchSheet(request: SheetSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          sheetRenderState(await computeSheetScene(context, request), bodyId),
        )
        .then(
          settleWithVerdict("sheet", bodyId),
          failWithVerdict("sheet", bodyId),
        );
    },
    dispatchSplit(request: SplitSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(await computeSplitScene(context, request), bodyId),
        )
        .then(
          settleWithVerdict("split", bodyId),
          failWithVerdict("split", bodyId),
        );
    },
    dispatchPatternFeature(
      request: PatternFeatureSceneRequest,
      bodyId: string,
    ): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computePatternFeatureScene(context, request),
            bodyId,
          ),
        )
        .then(
          settleWithVerdict("patternFeature", bodyId),
          failWithVerdict("patternFeature", bodyId),
        );
    },
    dispatchPatternPath(
      request: PatternPathSceneRequest,
      bodyId: string,
    ): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computePatternPathScene(context, request),
            bodyId,
          ),
        )
        .then(
          settleWithVerdict("patternPath", bodyId),
          failWithVerdict("patternPath", bodyId),
        );
    },
    dispatchMirror(request: MirrorSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computeMirrorScene(context, request),
            bodyId,
          ),
        )
        .then(
          settleWithVerdict("mirror", bodyId),
          failWithVerdict("mirror", bodyId),
        );
    },
    dispatchBoolean(request: BooleanSceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computeBooleanScene(context, request),
            bodyId,
          ),
        )
        .then(
          settleWithVerdict("boolean", bodyId),
          failWithVerdict("boolean", bodyId),
        );
    },
    dispatchMoveBody(request: MoveBodySceneRequest, bodyId: string): void {
      counters.dispatched += 1;
      errorText = "";
      writeSurface();
      coordinator
        .update(async (context) =>
          extrudeRenderState(
            await computeMoveBodyScene(context, request),
            bodyId,
          ),
        )
        .then(
          settleWithVerdict("moveBody", bodyId),
          failWithVerdict("moveBody", bodyId),
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
