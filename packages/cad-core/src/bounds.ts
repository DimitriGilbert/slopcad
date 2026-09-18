/**
 * Bounds measurement (Phase 27.1): the domain core behind the workbench's
 * bounds inspection and the measurement surfaces that follow it.
 *
 * An axis-aligned bounding box crosses every boundary in one structural
 * shape — the kernel contract's `KernelBounds`, the render projection's
 * `RenderBounds`, and the import pipeline's mesh bounds are all
 * `{ min, max }` xyz triples in canonical millimetres — so this module
 * speaks that shape once for all of them.
 *
 * The extents (max − min per axis) are the bounding DIMENSIONS the
 * measurement surfaces display. They are measured as canonical-millimetre
 * dimensional values — the Phase 4 unit infrastructure every measurement
 * tool shares — and formatted in the fixtures' established
 * `30.000 × 20.000 × 10.000` extents form, the one bounds display
 * convention of the product.
 *
 * Selection wiring: a bounds inspection needs exactly one subject body. A
 * selection resolves to that body when every body-addressing reference in
 * it agrees — `body`/`solid`/synthetic references carry their body id, a
 * `feature` reference resolves through the feature's single declared
 * output, and a selection that spans several bodies (or turns on an
 * ambiguous feature) resolves to nothing rather than an arbitrary subject.
 */

import type { FeatureRecord } from "./document";
import type { BodyId, FeatureId } from "./ids";
import type { RenderBounds } from "./projection";

import { type LengthValue, length, valueIn } from "./dimensional";
import { type SelectionReference, selectionReferenceBodyId } from "./selection";

/**
 * Measures the bounding dimensions of an axis-aligned box: the three axis
 * extents as canonical-millimetre lengths.
 */
export function boundsExtents(
  bounds: RenderBounds,
): readonly [LengthValue, LengthValue, LengthValue] {
  return [
    length(bounds.max[0] - bounds.min[0]),
    length(bounds.max[1] - bounds.min[1]),
    length(bounds.max[2] - bounds.min[2]),
  ];
}

/**
 * Formats the bounding dimensions in the fixtures' extents form —
 * `30.000 × 20.000 × 10.000` — three decimals, canonical millimetres,
 * fixed order x, y, z. The unit is the callers' suffix (the readouts
 * render `… mm`), so the string itself stays the byte-stable value the
 * machine surfaces carry.
 */
export function formatBoundsExtents(bounds: RenderBounds): string {
  const [x, y, z] = boundsExtents(bounds);
  return [valueIn(x, "mm"), valueIn(y, "mm"), valueIn(z, "mm")]
    .map((extent) => extent.toFixed(3))
    .join(" × ");
}

/** The output body of a single-output feature, or `undefined` otherwise. */
function featureOutputBody(
  features: readonly FeatureRecord[],
  featureId: FeatureId,
): BodyId | undefined {
  const feature = features.find((candidate) => candidate.id === featureId);
  if (feature === undefined || feature.outputs.length !== 1) {
    return undefined;
  }
  return feature.outputs[0];
}

/**
 * Resolves the one body a selection names for measurement purposes: the
 * body every body-addressing reference agrees on, or `undefined` when the
 * selection names none, several, or only ambiguous subjects.
 */
export function selectedBoundsBody(
  selected: readonly SelectionReference[],
  features: readonly FeatureRecord[],
): BodyId | undefined {
  let subject: BodyId | undefined;
  for (const reference of selected) {
    const bodyId =
      reference.kind === "feature"
        ? featureOutputBody(features, reference.featureId)
        : selectionReferenceBodyId(reference);
    if (bodyId === undefined) continue;
    if (subject === undefined) {
      subject = bodyId;
    } else if (subject !== bodyId) {
      return undefined;
    }
  }
  return subject;
}
