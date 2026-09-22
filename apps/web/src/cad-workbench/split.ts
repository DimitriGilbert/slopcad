/**
 * The workbench's split wiring (Phase 41): the document reader for the
 * split feature — the target (the last extrude, the thread precedent), a
 * DATUM PLANE input (the cutting plane), and one dimensionless parameter
 * (the keep side: +1 the normal's side, −1 the opposite). The worker
 * scene composes the bridge's own `planSplitCut` tool (the ONE source of
 * the covering-box geometry) through `solid.extrude` + `solid.subtract`,
 * with the both-ways post-condition (removed nothing / removed everything)
 * riding the computation REJECTION — the thread scene's carrier.
 */

import { valueIn, type AnyDimensionalValue } from "@slopcad/cad-core";

import { resolveSessionDatumPlane } from "./datum";
import { documentExtrudeRequest, type ExtrudeSceneRequest } from "./extrude";

/** The worker-scene payload one split feature executes as. */
export interface SplitSceneRequest {
  /** The base extrusion the feature splits. */
  readonly base: ExtrudeSceneRequest;
  /** The resolved datum plane the cut runs on. */
  readonly plane: {
    readonly origin: readonly [number, number, number];
    readonly normal: readonly [number, number, number];
  };
  /** `+1` keeps the normal's side, `−1` the opposite. */
  readonly side: 1 | -1;
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads the document's FIRST split feature into its worker-scene request,
 * resolving the datum plane through the session's plane seam (an
 * unresolvable datum declines the whole request — the thread reader's
 * discipline, never a silent world-plane fallback). `null` when the
 * document carries no split feature, the base no longer resolves, the
 * plane no longer resolves, or the side selector no longer reads.
 */
export function documentSplitSceneRequest(
  document: Parameters<typeof documentExtrudeRequest>[0],
): SplitSceneRequest | null {
  const feature = document.features.find((entry) => entry.kind === "split");
  if (feature === undefined) return null;
  const bodyId = feature.outputs[0];
  const datumRef = feature.inputs.find((ref) => ref.kind === "datum");
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (
    bodyId === undefined ||
    datumRef === undefined ||
    datumRef.kind !== "datum" ||
    parameterRefs.length !== 1
  ) {
    return null;
  }
  const parameter = document.parameters.parameters.find(
    (entry) => entry.id === parameterRefs[0]?.id,
  );
  const value: AnyDimensionalValue | undefined = parameter?.value;
  if (value === undefined || value.dimension !== "dimensionless") return null;
  const side = valueIn(value, "1");
  if ((side !== 1 && side !== -1) || !Number.isFinite(side)) return null;
  const resolved = resolveSessionDatumPlane(document, datumRef.id);
  if (!resolved.ok) return null;
  const base = documentExtrudeRequest(document);
  if (base === null) return null;
  return {
    base,
    plane: {
      origin: [resolved.origin[0], resolved.origin[1], resolved.origin[2]],
      normal: [resolved.normal[0], resolved.normal[1], resolved.normal[2]],
    },
    side: side === -1 ? -1 : 1,
    bodyId,
  };
}
