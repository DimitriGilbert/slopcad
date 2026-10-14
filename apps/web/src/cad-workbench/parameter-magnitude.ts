/**
 * The document readers' ONE parameter-magnitude seam: a parameter input's
 * current value by id, and that value's canonical magnitude when it
 * carries the role's dimension. The primitive, topology-cut, face-op,
 * pattern, and chain-fillet readers (`./primitive`, `./topology-cut`,
 * `./face-op`, `./pattern`, `./chain`) all read their numbers through it,
 * so the dimension check and the finiteness rule live in one place; each
 * reader layers its own domain check on top.
 *
 * A neutral module on purpose: `./pattern` imports `./topology-cut`, so
 * the seam cannot live in either without an import cycle.
 */

import { valueIn, type AnyDimensionalValue } from "@slopcad/cad-core";
import type { CadDocument } from "@slopcad/cad-core";

/** One parameter input's value, or `undefined` when it no longer resolves. */
export function parameterValueOf(
  document: CadDocument,
  id: string,
): AnyDimensionalValue | undefined {
  return document.parameters.parameters.find((entry) => entry.id === id)?.value;
}

/**
 * Reads a parameter's canonical magnitude, or `null` when the value is
 * missing, off-dimension, or not finite.
 */
export function magnitudeIn(
  value: AnyDimensionalValue | undefined,
  dimension: "length" | "dimensionless" | "angle",
  unit: "mm" | "1" | "rad",
): number | null {
  if (value === undefined || value.dimension !== dimension) return null;
  const magnitude = valueIn(value, unit);
  return Number.isFinite(magnitude) ? magnitude : null;
}
