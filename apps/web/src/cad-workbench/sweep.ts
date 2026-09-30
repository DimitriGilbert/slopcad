/**
 * The workbench's sweep wiring (Phase 38): the one module that bridges the
 * sketch domain, the document model, and the kernel contract for the
 * sketch-pair → sweep → solid workflow — the sweep sibling of `./extrude`
 * and `./revolve`.
 *
 * ## The path source and its constraint mapping (documented)
 *
 * A sweep consumes TWO sketch records: the profile and the path. The
 * profile resolves exactly like an extrude's (closed loop + workplane
 * placement — `sketchProfileResolverOf`). The path resolves through
 * cad-sketch's `resolveSweepPath` (the open-chain sibling of profile
 * resolution) and maps onto the kernel contract's LOCAL XZ plane by
 * coordinate identity: sketch (x, y) → path (x, z). That is the planar-XZ
 * contract's constraint mapping — the path sketch is a flat drawing read
 * in the PROFILE's frame; the path sketch's own workplane does not carry,
 * because {@link ProfileSweepInput} places the whole operation once, through
 * the profile's placement. The kernel's own validation judges the result:
 * the chain must START at the local origin (sketch point (0, 0)), its first
 * tangent must be +z (drawn "upward" in the sketch), it must stay G1, and
 * it must not self-intersect.
 *
 * ## The action's validation seam
 *
 * {@link validateSweepSubmission} runs the kernel contract's shared path
 * battery BEFORE anything is committed — the revolve action's
 * `revolveCrossesAxis` precedent: structural path problems
 * (`sweepPathProblem`), self-intersection (`sweepPathSelfIntersecting`),
 * and the bend-pinch check (`sweepProfileArcAxisCrossing`) each refuse with
 * the kernel's own structured code, so a doomed sweep never touches the
 * document.
 */

import type {
  CadDocument,
  FeatureRecord,
  ParseFailure,
  SketchDocumentId,
} from "@slopcad/cad-core";
import { angle as angleValue } from "@slopcad/cad-core";
import type {
  KernelPathResolution,
  KernelPathResolver,
  ProfileSweepInput,
} from "@slopcad/cad-kernel";
import {
  sweepPathProblem,
  sweepPathSelfIntersects,
  sweepProfileArcAxisCrossing,
} from "@slopcad/cad-kernel";
import type { SweepPathSegment } from "@slopcad/cad-sketch";
import { parseSketch, resolveSweepPath } from "@slopcad/cad-sketch";

import { sketchProfileResolverOf } from "./extrude";

/**
 * Maps one resolved sketch path segment onto the kernel contract's local
 * XZ plane: sketch (x, y) → path (x, z). A walk-reversed arc keeps its
 * negative signed sweep (the contract's directed-path convention).
 */
function kernelPathSegment(
  segment: SweepPathSegment,
): ProfileSweepInput["path"][number] {
  if (segment.kind === "line") {
    return {
      kind: "line",
      start: [segment.start.x, segment.start.y],
      end: [segment.end.x, segment.end.y],
    };
  }
  return {
    kind: "arc",
    center: [segment.center.x, segment.center.y],
    radius: segment.radius,
    startAngle: angleValue(segment.startAngle, "rad"),
    endAngle: angleValue(segment.endAngle, "rad"),
  };
}

/**
 * The document's sketch-path resolver: the caller-supplied seam the kernel
 * feature executor needs for `sweep` features (the planar-XZ mapping lives
 * here).
 */
export function sketchPathResolverOf(
  document: CadDocument,
): KernelPathResolver {
  return (sketchId: SketchDocumentId): KernelPathResolution => {
    const record = document.sketches.find((entry) => entry.id === sketchId);
    if (record === undefined) {
      const failure: ParseFailure = {
        code: "document/not-found",
        message: `No sketch record "${String(sketchId)}" exists in the document.`,
        input: sketchId,
      };
      return { ok: false, error: failure };
    }
    const sketch = parseSketch(record.sketch);
    if (!sketch.ok) {
      const failure: ParseFailure = {
        code: sketch.error.code,
        message: sketch.error.message,
        input: sketch.error.input,
      };
      return { ok: false, error: failure };
    }
    const path = resolveSweepPath(sketch.value.entities);
    if (!path.ok) {
      const failure: ParseFailure = {
        code: path.error.code,
        message: path.error.message,
        input: path.error.data,
      };
      return { ok: false, error: failure };
    }
    return {
      ok: true,
      value: { path: path.value.segments.map(kernelPathSegment) },
    };
  };
}

/** The outcome of one sweep validation attempt (the structured refusal). */
export type SweepValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Runs the kernel contract's sweep battery over the mapped loop + path
 * BEFORE any commit (the revolve action's validation seam). Refusals carry
 * the kernel's own structured codes verbatim.
 */
export function validateSweepSubmission(input: {
  readonly loop: ProfileSweepInput["loop"];
  readonly path: ProfileSweepInput["path"];
}): SweepValidation {
  const { loop, path } = input;
  const structural = sweepPathProblem(path);
  if (structural !== null) {
    return {
      ok: false,
      code: "kernel/invalid-path",
      message: `The sweep path is invalid: ${structural}.`,
    };
  }
  if (sweepPathSelfIntersects(path)) {
    return {
      ok: false,
      code: "kernel/path-self-intersecting",
      message:
        "The sweep path crosses itself; a crossing spine sweeps an undefined solid.",
    };
  }
  const pinch = sweepProfileArcAxisCrossing(loop, path);
  if (pinch !== null) {
    return {
      ok: false,
      code: "kernel/sweep-self-intersecting",
      message: `The profile crosses the bend axis at u = ${String(pinch.uAxis)} (signed distances span [${String(pinch.min)}, ${String(pinch.max)}]); the tube would pinch through the bend. Enlarge the bend radius or shrink the profile.`,
    };
  }
  return { ok: true };
}

/** The worker-scene payload one sweep feature executes as. */
export interface SweepSceneRequest {
  /** The closed profile loop (kernel contract form). */
  readonly loop: ProfileSweepInput["loop"];
  /** The open path chain in the local XZ plane (kernel contract form). */
  readonly path: ProfileSweepInput["path"];
  /** The placement (rotation axis/angle + translation) from the profile. */
  readonly placement: ProfileSweepInput["placement"];
  /** The sweep feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads ONE sweep feature into its worker-scene request, resolving both
 * sketches through the same paths the executor bridge uses. `null` when
 * the feature's inputs no longer resolve — callers render the prior scene
 * rather than fabricate geometry. The per-feature extraction the document
 * readers share (`documentSweepRequest` here, the document-scene builder's
 * per-body requests in `./document-scene`).
 */
export function sweepSceneRequestOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): SweepSceneRequest | null {
  const sketchRefs = feature.inputs.filter((ref) => ref.kind === "sketch");
  const bodyId = feature.outputs[0];
  const profileRef = sketchRefs[0];
  const pathRef = sketchRefs[1];
  if (
    sketchRefs.length !== 2 ||
    profileRef === undefined ||
    pathRef === undefined ||
    bodyId === undefined
  ) {
    return null;
  }
  const profile = sketchProfileResolverOf(document)(profileRef.id);
  if (!profile.ok) return null;
  const path = sketchPathResolverOf(document)(pathRef.id);
  if (!path.ok) return null;
  return {
    loop: profile.value.loop,
    path: path.value.path,
    placement: profile.value.placement,
    bodyId,
  };
}

/**
 * Reads the document's FIRST sweep feature into its worker-scene request.
 * `null` when the document carries no sweep feature or the feature's inputs
 * no longer resolve — callers render the prior scene rather than fabricate
 * geometry.
 */
export function documentSweepRequest(
  document: CadDocument,
): SweepSceneRequest | null {
  const feature = document.features.find((entry) => entry.kind === "sweep");
  if (feature === undefined) return null;
  return sweepSceneRequestOfFeature(document, feature);
}
