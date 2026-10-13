/**
 * The document readers' ONE world-axis selector seam: the bridge's
 * dimensionless axis selector (1 = X, 2 = Y, 3 = Z) mapped to its unit
 * direction. The move-body, duplicate, and face-op readers (`./move-body`,
 * `./duplicate`, `./face-op`) all resolve their axis parameters through
 * it, so the selector domain lives in one place.
 */

/** The world-axis selector's direction (the bridge's mapping). */
const WORLD_AXIS_DIRECTION: Readonly<
  Record<number, readonly [number, number, number]>
> = Object.freeze({
  1: [1, 0, 0] as const,
  2: [0, 1, 0] as const,
  3: [0, 0, 1] as const,
});

/**
 * The unit direction of a world-axis selector, or `undefined` when the
 * selector leaves the bridge's domain (anything but a whole 1, 2, or 3).
 */
export function worldAxisDirectionOf(
  selector: number,
): readonly [number, number, number] | undefined {
  return WORLD_AXIS_DIRECTION[selector];
}
