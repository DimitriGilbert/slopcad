/**
 * The document scene computation (Phase 16 owner fix): ONE worker pass
 * over the applied document's body list (`../cad-workbench/document-scene`
 * builds it) — each body's tagged scene executes through the SAME compute
 * functions the single-solid scenes use, and the aggregate measures the
 * DOCUMENT: volume, area, and triangles summed over the RENDERED bodies,
 * bounds their union. The settle surface's truth rides on that aggregate
 * (`data-volume` == the sum of what the viewport draws).
 *
 * ## Per-body failure honesty
 *
 * A body whose kernel build refuses does NOT fail the pass: the refusal is
 * recorded (the session surfaces it verbatim — the same structured text a
 * single-scene dispatch would), the body renders nothing, and its
 * lineage's embedded base state (the request every composing scene
 * carries — the hole's base extrusion, the boolean's operands) renders in
 * its place when the base body is still renderable. The scene shows
 * whatever IS valid at that point; it never fabricates the refused body.
 *
 * The computation stays a pure carrier of the operation matrix like every
 * other scene: no Date, no random, results derive from the requests alone.
 */

import type { ComputationContext, KernelBounds } from "@slopcad/cad-kernel";
import type { ExtrudeSceneRequest } from "../cad-workbench/extrude";
import type {
  DocumentBodyScene,
  DocumentBodySceneRequest,
} from "../cad-workbench/document-scene";
import type { PlateMeasurement } from "./plate-scene";

import { computeBooleanScene, computeMoveBodyScene } from "./body-ops-scenes";
import { computeExtrudeScene } from "./extrude-scene";
import { computeHelixScene } from "./helix-scene";
import { computeHoleScene } from "./hole-scene";
import { computeLoftScene } from "./loft-scene";
import { computePadScene } from "./pad-scene";
import { computePatternFeatureScene } from "./pattern-scene";
import { computePatternPathScene } from "./pattern-scene";
import { computeMirrorScene } from "./pattern-scene";
import { computeRevolveScene } from "./revolve-scene";
import {
  computeRibScene,
  computeScaleScene,
  computeSplitScene,
  computeThickenScene,
} from "./feature-richness-scenes";
import { computePlateWithHole } from "./plate-scene";
import { computeSheetScene } from "./sheet-scene";
import { computeSweepScene } from "./sweep-scene";
import { computeThreadScene } from "./thread-scene";

/** One rendered body's measurement, keyed by the body it renders under. */
export interface DocumentSceneBodyMeasurement {
  readonly bodyId: string;
  readonly measurement: PlateMeasurement;
  /**
   * Present exactly for open SHEET bodies (the sheet scene's truth): the
   * render layer answers with a both-sides material.
   */
  readonly openShell?: boolean;
}

/** One body's structured worker refusal, carried to the session verbatim. */
export interface DocumentSceneFailure {
  /** The body whose scene the kernel refused. */
  readonly bodyId: string;
  /** The refused scene kind (the session's verdict surface vocabulary). */
  readonly scene: DocumentBodyScene["kind"];
  /** The raw failure — the session formats it (the shared failure text). */
  readonly failure: unknown;
}

/** What one document scene pass measures: the aggregate plus per body. */
export interface DocumentSceneMeasurement {
  /** The summed volume of the RENDERED bodies (mm³). */
  readonly volume: number;
  /** The summed surface area of the RENDERED bodies (mm²). */
  readonly area: number;
  /** The union bounds of the RENDERED bodies (mm). */
  readonly bounds: KernelBounds;
  /** The summed triangle count of the RENDERED bodies. */
  readonly triangles: number;
  /** Per rendered body: its id and its own kernel measurement. */
  readonly bodies: readonly DocumentSceneBodyMeasurement[];
  /** Per refused body: the structured refusal (the pass never throws). */
  readonly failures: readonly DocumentSceneFailure[];
}

/** One body's computed scene: its measurement plus its open-shell truth. */
interface OneBodyMeasurement {
  readonly measurement: PlateMeasurement;
  readonly openShell?: boolean;
}

/** Executes one body's scene through the compute function its kind names. */
async function computeOneBodyScene(
  context: ComputationContext,
  scene: DocumentBodyScene,
): Promise<OneBodyMeasurement> {
  switch (scene.kind) {
    case "plate":
      return {
        measurement: await computePlateWithHole(
          context,
          scene.request.holeDiameterMm,
        ),
      };
    case "extrude":
      return { measurement: await computeExtrudeScene(context, scene.request) };
    case "pad":
      return { measurement: await computePadScene(context, scene.request) };
    case "revolve":
      return { measurement: await computeRevolveScene(context, scene.request) };
    case "sweep":
      return { measurement: await computeSweepScene(context, scene.request) };
    case "loft":
      return { measurement: await computeLoftScene(context, scene.request) };
    case "helix":
      return { measurement: await computeHelixScene(context, scene.request) };
    case "thread":
      return { measurement: await computeThreadScene(context, scene.request) };
    case "rib":
      return { measurement: await computeRibScene(context, scene.request) };
    case "scale":
      return { measurement: await computeScaleScene(context, scene.request) };
    case "thicken":
      return { measurement: await computeThickenScene(context, scene.request) };
    case "split":
      return { measurement: await computeSplitScene(context, scene.request) };
    case "patternFeature":
      return {
        measurement: await computePatternFeatureScene(context, scene.request),
      };
    case "patternPath":
      return {
        measurement: await computePatternPathScene(context, scene.request),
      };
    case "mirror":
      return { measurement: await computeMirrorScene(context, scene.request) };
    case "boolean":
      return { measurement: await computeBooleanScene(context, scene.request) };
    case "moveBody":
      return {
        measurement: await computeMoveBodyScene(context, scene.request),
      };
    case "hole":
      return { measurement: await computeHoleScene(context, scene.request) };
    case "sheet": {
      const sheet = await computeSheetScene(context, scene.request);
      return {
        measurement: sheet.measurement,
        ...(sheet.openShell ? { openShell: true } : {}),
      };
    }
  }
}

/**
 * The lineage fallback of one refused scene: the embedded base extrusions
 * the composition carries, in render order. A boolean renders BOTH
 * operands (the union body is gone — the operands are the document's
 * truth); the single-base compositions render their base extrusion; the
 * independent kinds and the sheet chain carry nothing (a refused sheet
 * renders no partial chain).
 */
function fallbackExtrusionsOf(
  scene: DocumentBodyScene,
): readonly ExtrudeSceneRequest[] {
  switch (scene.kind) {
    case "pad":
      return [scene.request.base];
    case "hole":
      return [scene.request.base];
    case "boolean":
      return [scene.request.target, scene.request.tool];
    case "thread":
    case "rib":
    case "scale":
    case "thicken":
    case "split":
    case "patternFeature":
    case "patternPath":
    case "mirror":
    case "moveBody":
      return [scene.request.base];
    default:
      return [];
  }
}

/** The union of two kernel bounds (the aggregate's extent). */
function unionBoundsInto(
  aggregate: { min: [number, number, number]; max: [number, number, number] },
  bounds: KernelBounds,
): void {
  for (const axis of [0, 1, 2] as const) {
    aggregate.min[axis] = Math.min(aggregate.min[axis], bounds.min[axis]);
    aggregate.max[axis] = Math.max(aggregate.max[axis], bounds.max[axis]);
  }
}

/**
 * Computes the document scene: every body's scene in request order, the
 * aggregate over the bodies that rendered. The body-display keep rule
 * applies FIRST, per body (`renderableBodyIds` — the keep-rule-approved
 * body ids the caller passes): a hidden body renders nothing and is not
 * even computed, so an all-hidden document settles the honest empty
 * aggregate. A visible body the kernel refused is recorded and skipped,
 * with its lineage fallback rendered when present and still renderable —
 * a boolean renders BOTH operands, and a fallback whose body id already
 * rendered (another refused lineage's same shared base) never
 * double-counts.
 */
export async function computeDocumentScene(
  context: ComputationContext,
  bodies: readonly DocumentBodySceneRequest[],
  renderableBodyIds: ReadonlySet<string>,
): Promise<DocumentSceneMeasurement> {
  const rendered: DocumentSceneBodyMeasurement[] = [];
  const renderedIds = new Set<string>();
  const failures: DocumentSceneFailure[] = [];
  for (const body of bodies) {
    if (!renderableBodyIds.has(body.bodyId)) continue;
    try {
      const computed = await computeOneBodyScene(context, body.scene);
      rendered.push({
        bodyId: body.bodyId,
        measurement: computed.measurement,
        ...(computed.openShell === undefined
          ? {}
          : { openShell: computed.openShell }),
      });
      renderedIds.add(body.bodyId);
      continue;
    } catch (failure: unknown) {
      failures.push({
        bodyId: body.bodyId,
        scene: body.scene.kind,
        failure,
      });
    }
    for (const fallback of fallbackExtrusionsOf(body.scene)) {
      if (!renderableBodyIds.has(fallback.bodyId)) continue;
      if (renderedIds.has(fallback.bodyId)) continue;
      try {
        const measurement = await computeExtrudeScene(context, fallback);
        rendered.push({
          bodyId: fallback.bodyId,
          measurement,
        });
        renderedIds.add(fallback.bodyId);
      } catch {
        // The fallback refused too: the lineage renders nothing this pass.
      }
    }
  }
  const aggregate = {
    min: [
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
      Number.POSITIVE_INFINITY,
    ],
    max: [
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ],
  } satisfies { min: [number, number, number]; max: [number, number, number] };
  let volume = 0;
  let area = 0;
  let triangles = 0;
  for (const body of rendered) {
    volume += body.measurement.volume;
    area += body.measurement.area;
    triangles += body.measurement.triangles;
    unionBoundsInto(aggregate, body.measurement.bounds);
  }
  return {
    volume,
    area,
    triangles,
    bounds:
      rendered.length === 0
        ? { min: [0, 0, 0], max: [0, 0, 0] }
        : { min: aggregate.min, max: aggregate.max },
    bodies: rendered,
    failures,
  };
}
