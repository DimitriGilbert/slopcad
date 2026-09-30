/**
 * The document-scene policy (Phase 16 owner fix — "CAD software lets you
 * control what you see"): the applied workbench scene is the FULL applied
 * document — every valid, visible body's tessellation, one mesh per body —
 * not the newest feature's single solid. This module is the pure decision
 * of WHICH bodies render and WHAT each one's worker scene is; the worker
 * computation and the session dispatch live beside the other scenes
 * (`../worker-fixture/document-scene`, the session's `dispatchDocument`).
 *
 * ## The lineage rule
 *
 * A history-based document here keeps every feature output as its own body
 * record, and the composing features (hole, boolean, thread, rib, scale,
 * thicken, split, pattern, mirror, move, pad, the surface family) REBUILD
 * their operands inside their own scene — their output body's geometry
 * contains the operands'. Rendering every record would therefore draw the
 * same material three times over (the plain extrusion AND the holed
 * version AND the threaded version). The rule the model tree implies: each
 * body belongs to a LINEAGE, and a lineage renders its NEWEST active
 * output — a body is ABSORBED exactly when a rendered feature's build
 * reaches it through feature/body inputs (the generic closure below; the
 * pad's base is positional — the first extrude — and absorbed
 * explicitly). What remains per lineage is the tip, and the tips together
 * ARE the document.
 *
 * ## The active timeline
 *
 * The readers see the document's ACTIVE features only: a SUPPRESSED
 * feature and a feature PARKED behind the rollback marker are excluded
 * (the same boundary rule `rollbackZoneBoundary` enforces for the
 * regeneration pass — a rolled-back state must not show later bodies, so
 * parking the timeline also un-absorbs the bases the parked features
 * consumed and their plain forms render again). Feature states ride the
 * document data alone: a feature the document-data executor failed keeps
 * its scene request here, and the WORKER's per-body verdict decides what
 * renders — a refused body renders its embedded base fallback (the last
 * valid state of its lineage) while the structured refusal still surfaces
 * on the error surface and the timeline chip.
 *
 * ## Display flags
 *
 * The Phase 44 body-display keep rule (`bodyRendersInProjection`) governs
 * WHAT RENDERS, not the request list: `visible: false` hides a lineage,
 * and when any body is isolated only isolated bodies render — per TIP
 * record (the flags are body display state; a lineage's tip is how its
 * record materializes). The tip list stays PRE-display-filter — the
 * emptiness decision (`[]` ⇔ no active scene resolved) must never confuse
 * "the user hid everything" with "there is no scene", or the engine would
 * re-dispatch the fixture plate over an all-hidden document; the
 * computation applies the keep rule per body instead (the caller hands it
 * the same renderable set). An all-hidden scene is legal — the user's own
 * display state, the projection filter's own precedent — and settles an
 * honest empty scene.
 *
 * Determinism: the request list is a pure function of (document,
 * suppressed, rollback) — no Date, no random, no scene state.
 */

import type { CadDocument, FeatureRecord } from "@slopcad/cad-core";
import {
  bodyRendersInProjection,
  rollbackZoneBoundary,
} from "@slopcad/cad-core";
import type { FeatureId, FeatureRollbackPoint } from "@slopcad/cad-react";
import type { Tessellation } from "@slopcad/cad-kernel";

import { holeDiameterMm } from "../workbench-fixture/workbench-document";
import {
  documentBooleanSceneRequest,
  type BooleanSceneRequest,
} from "./boolean";
import { helixSceneRequestOfFeature, type HelixSceneRequest } from "./helix";
import { documentHoleSceneRequest, type HoleSceneRequest } from "./hole";
import { loftSceneRequestOfFeature, type LoftSceneRequest } from "./loft";
import {
  documentMoveBodySceneRequest,
  type MoveBodySceneRequest,
} from "./move-body";
import {
  documentMirrorSceneRequest,
  documentPatternFeatureSceneRequest,
  documentPatternPathSceneRequest,
  type MirrorSceneRequest,
  type PatternFeatureSceneRequest,
  type PatternPathSceneRequest,
} from "./pattern";
import { documentRibSceneRequest, type RibSceneRequest } from "./rib";
import {
  revolveSceneRequestOfFeature,
  type RevolveSceneRequest,
} from "./revolve";
import {
  documentScaleSceneRequest,
  documentThickenSceneRequest,
  type ScaleSceneRequest,
  type ThickenSceneRequest,
} from "./scale-thicken";
import { documentSplitSceneRequest, type SplitSceneRequest } from "./split";
import {
  documentSheetSceneRequest,
  type SheetSceneRequest,
} from "./surface-scene";
import { sweepSceneRequestOfFeature, type SweepSceneRequest } from "./sweep";
import { documentThreadSceneRequest, type ThreadSceneRequest } from "./thread";
import {
  documentPadSceneRequest,
  extrudeSceneRequestOfFeature,
  type ExtrudeSceneRequest,
  type PadSceneRequest,
} from "./extrude";

/**
 * One body's worker scene: the tagged request the document computation
 * executes. The kind vocabulary is the feature scenes' own (the session's
 * `FeatureSceneKind`), plus the fixture plate: a body carried by the
 * data-only translate/rotate chain of a holeDiameter-bearing document has
 * no feature scene of its own — it renders through the plate computation,
 * the exact scene the boot dispatches.
 */
export type DocumentBodyScene =
  | { readonly kind: "plate"; readonly request: PlateBodyRequest }
  | { readonly kind: "extrude"; readonly request: ExtrudeSceneRequest }
  | { readonly kind: "pad"; readonly request: PadSceneRequest }
  | { readonly kind: "revolve"; readonly request: RevolveSceneRequest }
  | { readonly kind: "sweep"; readonly request: SweepSceneRequest }
  | { readonly kind: "loft"; readonly request: LoftSceneRequest }
  | { readonly kind: "helix"; readonly request: HelixSceneRequest }
  | { readonly kind: "thread"; readonly request: ThreadSceneRequest }
  | { readonly kind: "rib"; readonly request: RibSceneRequest }
  | { readonly kind: "scale"; readonly request: ScaleSceneRequest }
  | { readonly kind: "thicken"; readonly request: ThickenSceneRequest }
  | { readonly kind: "split"; readonly request: SplitSceneRequest }
  | {
      readonly kind: "patternFeature";
      readonly request: PatternFeatureSceneRequest;
    }
  | {
      readonly kind: "patternPath";
      readonly request: PatternPathSceneRequest;
    }
  | { readonly kind: "mirror"; readonly request: MirrorSceneRequest }
  | { readonly kind: "boolean"; readonly request: BooleanSceneRequest }
  | { readonly kind: "moveBody"; readonly request: MoveBodySceneRequest }
  | { readonly kind: "hole"; readonly request: HoleSceneRequest }
  | { readonly kind: "sheet"; readonly request: SheetSceneRequest };

/** The fixture plate's own scene payload: the stored bore diameter. */
export interface PlateBodyRequest {
  readonly holeDiameterMm: number;
}

/** One rendered body's scene request: the body id plus its scene. */
export interface DocumentBodySceneRequest {
  /** The body record the scene renders under (the stable `rend_*` seed). */
  readonly bodyId: string;
  /** The body's worker scene. */
  readonly scene: DocumentBodyScene;
}

/**
 * The document's active features: not suppressed, not parked behind the
 * (stale-clamped) rollback marker — the same boundary the regeneration
 * pass runs the timeline with, read here so the scene and the tree can
 * never disagree about what is applied.
 */
function activeFeaturesOf(
  document: CadDocument,
  suppressed: ReadonlySet<FeatureId>,
  rollback: FeatureRollbackPoint | null,
): readonly FeatureRecord[] {
  const boundary = rollbackZoneBoundary(document.features, rollback);
  const executed = boundary.ok ? boundary.value : document.features.length;
  return document.features.filter(
    (feature, index) => index < executed && !suppressed.has(feature.id),
  );
}

/**
 * The bodies a rendered tip's build reaches: the closure over each tip's
 * producing feature's feature/body inputs (each input's output bodies,
 * then those bodies' producing features, transitively). Absorbed bodies do
 * not render — the tip's scene rebuilds them. A tip never absorbs ITSELF:
 * the data-only display features (translate, rotate) output the very body
 * they take as input, and that in-place chain renders the body, not its
 * absence. Another tip's build CAN consume it — the newest tip of a shared
 * base wins, and the older one drops.
 */
function absorbedBodiesOf(
  document: CadDocument,
  tips: ReadonlySet<string>,
): Set<string> {
  const absorbed = new Set<string>();
  const featureOfBody = (bodyId: string): FeatureRecord | undefined =>
    document.features.find((feature) =>
      feature.outputs.some((output) => output === bodyId),
    );
  const visit = (bodyId: string, root: string, depth: number): void => {
    if (depth > 32 || absorbed.has(bodyId) || bodyId === root) return;
    absorbed.add(bodyId);
    const feature = featureOfBody(bodyId);
    if (feature === undefined) return;
    for (const ref of feature.inputs) {
      if (ref.kind === "feature") {
        const input = document.features.find((entry) => entry.id === ref.id);
        for (const output of input?.outputs ?? []) {
          visit(output, root, depth + 1);
        }
      }
      // A direct body input (the surface family's operand bodies) absorbs
      // the named body itself.
      if (ref.kind === "body") visit(ref.id, root, depth + 1);
    }
  };
  for (const tip of tips) {
    // The tip itself is rendered, not absorbed — seed its REACH, not it.
    const feature = featureOfBody(tip);
    if (feature === undefined) continue;
    for (const ref of feature.inputs) {
      if (ref.kind === "feature") {
        const input = document.features.find((entry) => entry.id === ref.id);
        for (const output of input?.outputs ?? []) visit(output, tip, 0);
      }
      if (ref.kind === "body") visit(ref.id, tip, 0);
    }
  }
  return absorbed;
}

/**
 * The body ids the body-display keep rule lets render: `visible: false`
 * drops a body, and when any body is isolated only the isolated bodies
 * remain. The engine hands this set to the session beside the (unfiltered)
 * tip list, and the computation applies it per body — so a hidden body
 * renders nothing AND a refused composition's lineage fallback can never
 * resurface it.
 */
export function renderableBodyIds(document: CadDocument): ReadonlySet<string> {
  const flags = new Map(
    document.bodies.map((body) => [
      body.id,
      { visible: body.visible, isolated: body.isolated },
    ]),
  );
  const anyIsolated = document.bodies.some((body) => body.isolated === true);
  const renderable = new Set<string>();
  for (const body of document.bodies) {
    if (bodyRendersInProjection(flags, body.id, anyIsolated)) {
      renderable.add(body.id);
    }
  }
  return renderable;
}

/**
 * Merges a document scene's per-body soups into ONE indexed tessellation —
 * the single-soup contract the mesh exporters consume. Deterministic
 * (document body order, indices rebased per body); the merge never
 * rewrites positions, and the kernel normals ride along only when EVERY
 * body carries them (the flat array must stay vertex-aligned).
 */
export function documentSceneTessellation(
  bodies: readonly {
    readonly measurement: { readonly tessellation: Tessellation };
  }[],
): Tessellation {
  const positions: number[] = [];
  const indices: number[] = [];
  const normals: number[] = [];
  let normalsComplete = true;
  for (const body of bodies) {
    const soup = body.measurement.tessellation;
    const base = positions.length / 3;
    for (let index = 0; index < soup.positions.length; index += 1) {
      const value = soup.positions[index];
      if (value !== undefined) positions.push(value);
    }
    for (const index of soup.indices) indices.push(base + index);
    if (soup.normals === undefined) {
      // A body without normals voids the merged normal array — it can
      // never be vertex-aligned again; nothing re-enables it.
      normalsComplete = false;
      continue;
    }
    for (let index = 0; index < soup.normals.length; index += 1) {
      const value = soup.normals[index];
      if (value !== undefined) normals.push(value);
    }
  }
  return {
    positions,
    indices,
    ...(normalsComplete && normals.length > 0 ? { normals } : {}),
  };
}

/**
 * Builds the document scene request: the body list whose scenes the
 * applied computation executes — one entry per lineage tip, in document
 * body order, BEFORE the body-display keep rule (hidden tips stay listed;
 * the computation skips them per body). `[]` only when no active feature's
 * scene resolves (the boot plate document among them) — the caller keeps
 * the plate dispatch for exactly that case, never for an all-hidden
 * document.
 */
export function documentSceneBodies(
  document: CadDocument,
  suppressed: ReadonlySet<FeatureId>,
  rollback: FeatureRollbackPoint | null,
): readonly DocumentBodySceneRequest[] {
  const active = activeFeaturesOf(document, suppressed, rollback);
  const activeDocument: CadDocument = { ...document, features: active };

  // The per-body scene requests, keyed by body id. The independent kinds
  // land first (every extrude, revolve, sweep, loft, helix, sheet body of
  // the active timeline); the consuming readers then overwrite their tip
  // entries — a tip body's independent form (the pad body's plain extrude)
  // must not survive its own composition.
  const requests = new Map<string, DocumentBodyScene>();
  for (const feature of active) {
    switch (feature.kind) {
      case "extrude": {
        const request = extrudeSceneRequestOfFeature(activeDocument, feature);
        if (request !== null) {
          requests.set(request.bodyId, { kind: "extrude", request });
        }
        break;
      }
      case "revolve": {
        const request = revolveSceneRequestOfFeature(activeDocument, feature);
        if (request !== null) {
          requests.set(request.bodyId, { kind: "revolve", request });
        }
        break;
      }
      case "sweep": {
        const request = sweepSceneRequestOfFeature(activeDocument, feature);
        if (request !== null) {
          requests.set(request.bodyId, { kind: "sweep", request });
        }
        break;
      }
      case "loft": {
        const request = loftSceneRequestOfFeature(activeDocument, feature);
        if (request !== null) {
          requests.set(request.bodyId, { kind: "loft", request });
        }
        break;
      }
      case "helix": {
        const request = helixSceneRequestOfFeature(activeDocument, feature);
        if (request !== null) {
          requests.set(request.bodyId, { kind: "helix", request });
        }
        break;
      }
      default:
        break;
    }
  }

  // The surface family: the sheet reader resolves ONE chain (the latest
  // surface feature's rebuild plan, operands embedded); only its tip gets
  // the entry — earlier chain members are absorbed through the
  // feature-graph closure below.
  const sheet = documentSheetSceneRequest(activeDocument);
  if (sheet !== null) {
    requests.set(sheet.bodyId, { kind: "sheet", request: sheet });
  }

  // The fixture-plate body: a body whose producer CHAIN bottoms out in
  // data-only features (translate/rotate — display-state features with no
  // scene of their own) in a document that carries the fixture's
  // holeDiameter parameter. The chain check is transitive on purpose: a
  // move-body feature is ALSO a translate, but its input chain reaches an
  // extrude — a moved body renders through its own scene, never as a
  // second plate. The plate body renders through the plate computation —
  // the exact scene the boot dispatches — as one body among the rest. A
  // document with NO other scene (the boot itself) stays on the dedicated
  // plate dispatch, whose authored fixed camera the boot baselines pin.
  const storedHole = holeDiameterMm(document);
  if (storedHole !== null && requests.size > 0) {
    const dataOnly = new Set<string>();
    const chainIsDataOnly = (bodyId: string, stack: Set<string>): boolean => {
      if (dataOnly.has(bodyId)) return true;
      if (stack.has(bodyId)) return true; // the plate's own in-place loop
      const producers = active.filter((feature) =>
        feature.outputs.some((output) => output === bodyId),
      );
      if (
        producers.length === 0 ||
        !producers.every(
          (feature) =>
            feature.kind === "translate" || feature.kind === "rotate",
        )
      ) {
        return false;
      }
      stack.add(bodyId);
      for (const feature of producers) {
        for (const ref of feature.inputs) {
          if (ref.kind === "feature") {
            const input = active.find((entry) => entry.id === ref.id);
            for (const output of input?.outputs ?? []) {
              if (!chainIsDataOnly(output, stack)) return false;
            }
          }
          if (ref.kind === "body" && !chainIsDataOnly(ref.id, stack)) {
            return false;
          }
        }
      }
      dataOnly.add(bodyId);
      return true;
    };
    for (const body of document.bodies) {
      if (requests.has(body.id)) continue;
      if (chainIsDataOnly(body.id, new Set())) {
        requests.set(body.id, {
          kind: "plate",
          request: { holeDiameterMm: storedHole },
        });
      }
    }
  }

  // The consuming compositions: each reader names its lineage tip (and
  // rebuilds the lineage's earlier bodies inside the tip's scene).
  const pad = documentPadSceneRequest(activeDocument);
  if (pad !== null) {
    requests.set(pad.bodyId, { kind: "pad", request: pad });
  }
  const hole = documentHoleSceneRequest(activeDocument);
  if (hole !== null) {
    requests.set(hole.bodyId, { kind: "hole", request: hole.request });
  }
  const thread = documentThreadSceneRequest(activeDocument);
  if (thread !== null) {
    requests.set(thread.bodyId, { kind: "thread", request: thread });
  }
  const rib = documentRibSceneRequest(activeDocument);
  if (rib !== null) {
    requests.set(rib.bodyId, { kind: "rib", request: rib });
  }
  const scale = documentScaleSceneRequest(activeDocument);
  if (scale !== null) {
    requests.set(scale.bodyId, { kind: "scale", request: scale });
  }
  const thicken = documentThickenSceneRequest(activeDocument);
  if (thicken !== null) {
    requests.set(thicken.bodyId, { kind: "thicken", request: thicken });
  }
  const split = documentSplitSceneRequest(activeDocument);
  if (split !== null) {
    requests.set(split.bodyId, { kind: "split", request: split });
  }
  const patternFeature = documentPatternFeatureSceneRequest(activeDocument);
  if (patternFeature !== null) {
    requests.set(patternFeature.bodyId, {
      kind: "patternFeature",
      request: patternFeature,
    });
  }
  const patternPath = documentPatternPathSceneRequest(activeDocument);
  if (patternPath !== null) {
    requests.set(patternPath.bodyId, {
      kind: "patternPath",
      request: patternPath,
    });
  }
  const mirror = documentMirrorSceneRequest(activeDocument);
  if (mirror !== null) {
    requests.set(mirror.bodyId, { kind: "mirror", request: mirror });
  }
  const boolean = documentBooleanSceneRequest(activeDocument);
  if (boolean !== null) {
    requests.set(boolean.bodyId, { kind: "boolean", request: boolean });
  }
  const moveBody = documentMoveBodySceneRequest(activeDocument);
  if (moveBody !== null) {
    requests.set(moveBody.bodyId, { kind: "moveBody", request: moveBody });
  }

  if (requests.size === 0) return [];

  // The absorption closure over the rendered tips; the pad's base is
  // POSITIONAL (first extrude, not a declared input), so it absorbs
  // explicitly.
  const absorbed = absorbedBodiesOf(activeDocument, new Set(requests.keys()));
  if (pad !== null) absorbed.add(pad.base.bodyId);

  // The list stays PRE-display-filter: the emptiness decision above must
  // mean "no scene resolved", never "the user hid every body" — an
  // all-hidden document keeps the document dispatch (the computation's
  // keep-rule skip renders it as the honest empty scene) instead of
  // re-materializing the fixture plate.
  const rendered: DocumentBodySceneRequest[] = [];
  for (const body of document.bodies) {
    if (absorbed.has(body.id)) continue;
    const scene = requests.get(body.id);
    if (scene === undefined) continue;
    rendered.push({ bodyId: body.id, scene });
  }
  return rendered;
}
