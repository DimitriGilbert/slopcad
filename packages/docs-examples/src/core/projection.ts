/**
 * The `R3F` (data half) and `selection` guides' runnable example
 * (docs/guides/r3f.md, docs/guides/selection.md): the renderer-neutral
 * projection — a kernel tessellation projected into a render object and
 * assembled with a camera into the `RenderProjection` the R3F layer
 * consumes as pure data — plus the selection state machine over the
 * projected body: a body pick, a toggling second pick, and the hover.
 */

import {
  createBodyId,
  createFeatureId,
  createRenderProjection,
  createSelectionState,
  hoverSelection,
  parseRenderCamera,
  pickSelection,
  projectTessellation,
  selectionReferenceKey,
  serializeRenderProjection,
  type RenderCamera,
  type RenderProjection,
  type SelectionState,
} from "@slopcad/cad-core";

import { unwrap } from "./document";

/** The example's body and feature ids. */
export const PROJECTION_BODY = createBodyId("body_guide_plate");
const PROJECTION_FEATURE = createFeatureId("feat_guide_plate");

/** The deterministic camera the example frames its plate with. */
export const GUIDE_CAMERA: RenderCamera = {
  kind: "perspective",
  position: [44, -30, 47],
  target: [15, 10, 5],
  up: [0, 0, 1],
  fovDeg: 40,
};

/** A plate-with-bore tessellation: the kernel contract's flat soup form. */
const PLATE_TESSELLATION = {
  positions: [
    0, 0, 0, 30, 0, 0, 30, 20, 0, 0, 20, 0, 0, 0, 10, 30, 0, 10, 30, 20, 10, 0,
    20, 10,
  ],
  indices: [
    0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1,
    2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
  ],
  normals: undefined,
} as const;

/** What the example reports back to the guide and the docs page. */
export interface ProjectionExampleSummary {
  readonly objectId: string;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly projectionObjectCount: number;
  readonly selectedKeys: readonly string[];
  readonly hoveredKey: string | null;
  readonly serializedBytes: number;
  readonly firstPickCount: number;
}

/** Projects the plate and drives the selection machine over it. */
export function runProjectionExample(): {
  readonly summary: ProjectionExampleSummary;
  readonly projection: RenderProjection;
} {
  // One kernel tessellation → one render object, keyed by the body id.
  const object = unwrap(
    projectTessellation(
      PROJECTION_BODY,
      PLATE_TESSELLATION,
      PROJECTION_FEATURE,
    ),
    "plate render object",
  );

  // The camera parses through the same boundary untrusted input does.
  const camera = unwrap(parseRenderCamera(GUIDE_CAMERA), "guide camera");

  const projection = unwrap(
    createRenderProjection([object], camera),
    "guide projection",
  );

  // Selection: single-mode pick replaces; multi-mode pick toggles.
  let selection: SelectionState = createSelectionState(0);
  selection = unwrap(
    pickSelection(
      selection,
      { kind: "body", bodyId: PROJECTION_BODY },
      { additive: false },
    ),
    "body pick",
  );
  const afterFirstPick = selection.selected.length;
  selection = unwrap(
    pickSelection(
      selection,
      { kind: "feature", featureId: PROJECTION_FEATURE },
      { additive: true },
    ),
    "feature toggle",
  );
  selection = unwrap(
    pickSelection(
      selection,
      { kind: "feature", featureId: PROJECTION_FEATURE },
      { additive: true },
    ),
    "feature toggle off",
  );
  const hovered = unwrap(
    hoverSelection(selection, { kind: "body", bodyId: PROJECTION_BODY }),
    "hover",
  );

  // The projection serializes deterministically (the wire form a host can
  // ship across a worker or network boundary).
  const serialized = JSON.stringify(serializeRenderProjection(projection));

  return {
    projection,
    summary: {
      objectId: object.id,
      vertexCount: object.positions.length / 3,
      triangleCount: object.indices.length / 3,
      projectionObjectCount: projection.objects.length,
      selectedKeys: hovered.selected.map(selectionReferenceKey),
      hoveredKey:
        hovered.hover === null ? null : selectionReferenceKey(hovered.hover),
      serializedBytes: serialized.length,
      firstPickCount: afterFirstPick,
    },
  };
}
