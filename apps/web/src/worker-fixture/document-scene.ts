/**
 * The document scene computation (Phase 16 owner fix): ONE worker pass
 * over the applied document's body list (`../cad-workbench/document-scene`
 * builds it) — each body's tagged scene executes through the SAME compute
 * functions the single-solid scenes use, and the aggregate measures the
 * DOCUMENT: volume, area, and triangles summed over the RENDERED bodies,
 * bounds their union. The settle surface's truth rides on that aggregate
 * (`data-volume` == the sum of what the viewport draws).
 *
 * ## The operand handoff (real-CAD composition)
 *
 * The request list is the document's topological order, so a consumed
 * base a rendered consumer needs (`consumedOnly`) computes BEFORE its
 * consumer and the pass keys its solid by the body id. A boolean, hole,
 * or move whose operand is such a body composes from that COMPUTED solid
 * — the operand's current geometry, earlier features included (a pocket
 * cut from a holed block keeps the window) — while a plain-extrude
 * operand keeps re-executing its own embedded derivation, byte-identical
 * to every established flow.
 *
 * ## Per-body failure honesty
 *
 * A body whose kernel build refuses does NOT fail the pass: the refusal is
 * recorded (the session surfaces it verbatim — the same structured text a
 * single-scene dispatch would), the body renders nothing, and its
 * lineage's operand state renders in its place when still renderable —
 * an extrude-derived operand re-executes its extrusion, a computed
 * operand surfaces the measurement its scene already produced. The scene
 * shows whatever IS valid at that point; it never fabricates the refused
 * body.
 *
 * The computation stays a pure carrier of the operation matrix like every
 * other scene: no Date, no random, results derive from the requests alone.
 */

import type {
  ComputationContext,
  KernelBounds,
  WorkerSolidId,
} from "@slopcad/cad-kernel";
import type {
  ExtrudeSceneRequest,
  SceneOperand,
} from "../cad-workbench/extrude";
import type {
  DocumentBodyScene,
  DocumentBodySceneRequest,
} from "../cad-workbench/document-scene";
import type { PlateMeasurement } from "./plate-scene";

import {
  computeBooleanScene,
  computeDuplicateScene,
  computeMoveBodyScene,
} from "./body-ops-scenes";
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

/**
 * One body's computed scene: its measurement, its open-shell truth, and —
 * for the operand-capable compositions (pad, hole, boolean, move) — the
 * solid the pass keys by the body id so a later consumer composes from
 * this body's CURRENT geometry.
 */
interface OneBodyMeasurement {
  readonly measurement: PlateMeasurement;
  readonly openShell?: boolean;
  readonly solid?: WorkerSolidId;
}

/**
 * Executes one body's scene through the compute function its kind names,
 * handing the pass's computed solids to the operand-consuming
 * compositions.
 */
async function computeOneBodyScene(
  context: ComputationContext,
  scene: DocumentBodyScene,
  computed: ReadonlyMap<string, WorkerSolidId>,
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
    case "pad": {
      const composed = await computePadScene(context, scene.request);
      return { measurement: composed.measurement, solid: composed.solid };
    }
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
    case "boolean": {
      const composed = await computeBooleanScene(
        context,
        scene.request,
        computed,
      );
      return { measurement: composed.measurement, solid: composed.solid };
    }
    case "moveBody": {
      const composed = await computeMoveBodyScene(
        context,
        scene.request,
        computed,
      );
      return { measurement: composed.measurement, solid: composed.solid };
    }
    case "duplicate": {
      const composed = await computeDuplicateScene(
        context,
        scene.request,
        computed,
      );
      return { measurement: composed.measurement, solid: composed.solid };
    }
    case "hole": {
      const composed = await computeHoleScene(context, scene.request, computed);
      return { measurement: composed.measurement, solid: composed.solid };
    }
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
 * One lineage fallback source: an embedded extrusion (re-executed) or a
 * computed operand body (its measurement surfaced from earlier in the
 * pass — the operand's CURRENT state, prior features included).
 */
type FallbackSource =
  | { readonly kind: "extrude"; readonly request: ExtrudeSceneRequest }
  | { readonly kind: "computed"; readonly bodyId: string };

/** Maps one operand source onto its fallback source. */
function fallbackSourceOf(operand: SceneOperand): FallbackSource {
  return operand.kind === "extrude"
    ? { kind: "extrude", request: operand.request }
    : { kind: "computed", bodyId: operand.bodyId };
}

/**
 * The lineage fallback of one refused scene: the operand states the
 * composition carries, in operand order. An extrude-derived operand
 * renders its own extrusion; a computed operand renders the measurement
 * its scene already produced earlier in the pass — a refused boolean over
 * a holed block shows the HOLED block, the lineage's honest current
 * state. The pad renders its base extrusion; the independent kinds and
 * the sheet chain carry nothing (a refused sheet renders no partial
 * chain).
 */
function fallbackSourcesOf(
  scene: DocumentBodyScene,
): readonly FallbackSource[] {
  switch (scene.kind) {
    case "pad":
      return [{ kind: "extrude", request: scene.request.base }];
    case "hole":
      return [fallbackSourceOf(scene.request.base)];
    case "boolean":
      return [
        fallbackSourceOf(scene.request.target),
        ...scene.request.tools.map((tool) => fallbackSourceOf(tool)),
      ];
    case "thread":
    case "rib":
    case "scale":
    case "thicken":
    case "split":
    case "patternFeature":
    case "patternPath":
    case "mirror":
      return [{ kind: "extrude", request: scene.request.base }];
    case "moveBody":
      return [fallbackSourceOf(scene.request.base)];
    case "duplicate":
      return [fallbackSourceOf(scene.request.base)];
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
 * aggregate over the bodies that rendered. The request order is the
 * document's topological order, so a COMPUTE-ONLY entry (`consumedOnly` —
 * a consumed base a rendered consumer needs) evaluates before its
 * consumer and its solid is keyed by the body id for the handoff; the
 * body-display keep rule applies to the RENDERED entries only
 * (`renderableBodyIds` — the keep-rule-approved body ids the caller
 * passes): a hidden tip renders nothing and is not even computed, so an
 * all-hidden document settles the honest empty aggregate — while display
 * flags never break the MODEL (a hidden consumed base still computes for
 * its consumer). A body the kernel refused is recorded and skipped, with
 * its lineage fallback rendered when present and still renderable — a
 * boolean renders BOTH operands (an extrude-derived operand re-executes
 * its extrusion, a computed operand surfaces its pass measurement — the
 * body's current state, prior features included), and a fallback whose
 * body id already rendered (another refused lineage's same shared base)
 * never double-counts.
 */
export async function computeDocumentScene(
  context: ComputationContext,
  bodies: readonly DocumentBodySceneRequest[],
  renderableBodyIds: ReadonlySet<string>,
): Promise<DocumentSceneMeasurement> {
  const rendered: DocumentSceneBodyMeasurement[] = [];
  const renderedIds = new Set<string>();
  const failures: DocumentSceneFailure[] = [];
  // The pass's computed solids and measurements, keyed by body id — the
  // operand handoff between the compositions and their consumers, and the
  // refused lineage's honest fallback state.
  const computedSolids = new Map<string, WorkerSolidId>();
  const computedMeasurements = new Map<string, PlateMeasurement>();
  for (const body of bodies) {
    const consumedOnly = body.consumedOnly === true;
    if (!consumedOnly && !renderableBodyIds.has(body.bodyId)) continue;
    try {
      const computed = await computeOneBodyScene(
        context,
        body.scene,
        computedSolids,
      );
      if (computed.solid !== undefined) {
        computedSolids.set(body.bodyId, computed.solid);
      }
      computedMeasurements.set(body.bodyId, computed.measurement);
      if (consumedOnly) continue;
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
    for (const fallback of fallbackSourcesOf(body.scene)) {
      if (fallback.kind === "computed") {
        if (!renderableBodyIds.has(fallback.bodyId)) continue;
        if (renderedIds.has(fallback.bodyId)) continue;
        const measurement = computedMeasurements.get(fallback.bodyId);
        if (measurement === undefined) continue;
        rendered.push({ bodyId: fallback.bodyId, measurement });
        renderedIds.add(fallback.bodyId);
        continue;
      }
      if (!renderableBodyIds.has(fallback.request.bodyId)) continue;
      if (renderedIds.has(fallback.request.bodyId)) continue;
      try {
        const measurement = await computeExtrudeScene(
          context,
          fallback.request,
        );
        rendered.push({
          bodyId: fallback.request.bodyId,
          measurement,
        });
        renderedIds.add(fallback.request.bodyId);
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
