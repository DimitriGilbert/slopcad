/**
 * The genome coordinate system (Phase 70a): the solver-side mirror of the
 * study record's genes. The NSGA-II engine operates on UNIT slots — one
 * number per gene, numeric genes normalized to [0, 1], discrete genes an
 * integer choice index — and this module is the single decode/encode
 * boundary between those slots and the AUTHORED values the evaluation
 * driver re-drives the document with.
 *
 * Lattice honesty (the staircase caveat's genome half): a stepped or
 * integer gene's authored value always lands on its declared lattice
 * (`min + k·step`, k integral), whatever the slot's real value is — the
 * decoder snaps, the encoder inverts the snap exactly, and a stepped
 * lattice whose range spans fewer than two steps collapses to the single
 * level `min` (a constant gene the engine still carries, honest about
 * its one level). Discrete genes are pure enumerations: the slot IS the
 * choice index, and no operator ever interpolates between choices.
 */

/** The numeric gene spec: bounds and lattice in authored units. */
export interface NumericGeneSpec {
  readonly kind: "numeric";
  readonly valueKind: "integer" | "decimal";
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

/** The discrete gene spec: a pure enumeration of `choiceCount` choices. */
export interface DiscreteGeneSpec {
  readonly kind: "discrete";
  readonly choiceCount: number;
}

/** One gene of the solver-side genome, in study order. */
export type OptimizationGeneSpec = NumericGeneSpec | DiscreteGeneSpec;

/** A genome: one unit slot per gene, in gene order. */
export type GenomeSlots = readonly number[];

/** The authored form of one genome: parameter values and record choices. */
export interface AuthoredGenome {
  /**
   * Canonical-magnitude values per NUMERIC gene, in gene order — the
   * value the driver writes into the parameter table.
   */
  readonly numericValues: readonly number[];
  /** Choice indices per DISCRETE gene, in gene order. */
  readonly choiceIndices: readonly number[];
}

/**
 * The count of lattice levels a numeric gene can decode to (>= 1;
 * 1 = constant): a stepped gene spans at most floor((max − min)/step)
 * steps above `min` (k = 0 … that bound, so count = bound + 1 — a range
 * spanning fewer than TWO steps collapses to the constant `min`); a
 * step-less integer gene counts the integers inside its bounds; a
 * continuous decimal gene is unbounded (Infinity).
 */
export function numericGeneLevels(spec: NumericGeneSpec): number {
  if (spec.step === undefined) {
    return spec.valueKind === "integer"
      ? Math.max(1, Math.floor(spec.max) - Math.ceil(spec.min) + 1)
      : Number.POSITIVE_INFINITY;
  }
  const steps = Math.floor((spec.max - spec.min) / spec.step);
  return steps < 2 ? 1 : steps + 1;
}

/** Clamps a slot to the valid unit interval / choice range. */
export function clampSlot(spec: OptimizationGeneSpec, slot: number): number {
  if (spec.kind === "discrete") {
    const index = Math.round(slot);
    if (!Number.isFinite(index)) return 0;
    return Math.min(spec.choiceCount - 1, Math.max(0, index));
  }
  if (!Number.isFinite(slot)) return 0;
  return Math.min(1, Math.max(0, slot));
}

/**
 * Decodes a unit slot to its authored value — the lattice snap included:
 * stepped genes land on `min + k·step`, step-less integers on the integer
 * grid, continuous decimals interpolate linearly.
 */
export function decodeNumericSlot(spec: NumericGeneSpec, slot: number): number {
  const t = Math.min(1, Math.max(0, slot));
  if (spec.step !== undefined) {
    const levels = numericGeneLevels(spec);
    if (levels === 1) return spec.min;
    const topIndex = levels - 1;
    const k = Math.min(topIndex, Math.max(0, Math.round(t * topIndex)));
    return spec.min + k * spec.step;
  }
  const interpolated = spec.min + t * (spec.max - spec.min);
  return spec.valueKind === "integer"
    ? Math.min(
        Math.floor(spec.max),
        Math.max(Math.ceil(spec.min), Math.round(interpolated)),
      )
    : interpolated;
}

/**
 * Encodes an authored value back to its unit slot — the exact inverse of
 * {@link decodeNumericSlot} for lattice values (stepped and step-less
 * integer genes), and the clamped linear map for continuous ones.
 */
export function encodeNumericSlot(
  spec: NumericGeneSpec,
  value: number,
): number {
  if (spec.step !== undefined) {
    const levels = numericGeneLevels(spec);
    if (levels === 1) return 0;
    const topIndex = levels - 1;
    const k = Math.min(
      topIndex,
      Math.max(0, Math.round((value - spec.min) / spec.step)),
    );
    return k / topIndex;
  }
  if (spec.valueKind === "integer") {
    const levels = numericGeneLevels(spec);
    if (levels === 1) return 0;
    const k = Math.min(
      levels - 1,
      Math.max(0, Math.round(value) - Math.ceil(spec.min)),
    );
    return k / (levels - 1);
  }
  const t = (value - spec.min) / (spec.max - spec.min);
  return Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
}

/** Decodes a whole genome to its authored form. */
export function decodeGenome(
  specs: readonly OptimizationGeneSpec[],
  slots: GenomeSlots,
): AuthoredGenome {
  const numericValues: number[] = [];
  const choiceIndices: number[] = [];
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const slot = slots[index] ?? 0;
    if (spec === undefined) continue;
    if (spec.kind === "numeric") {
      numericValues.push(decodeNumericSlot(spec, slot));
    } else {
      choiceIndices.push(clampSlot(spec, slot));
    }
  }
  return { numericValues, choiceIndices };
}

/**
 * The canonical string of an authored genome — the evaluation cache key.
 * Fixed field order, numbers by their exact ECMAScript string form, so
 * identical authored genomes always key identically (the honest dedupe:
 * two slot vectors that decode to the same lattice points are ONE
 * candidate and evaluate once).
 */
export function authoredGenomeKey(genome: AuthoredGenome): string {
  return JSON.stringify([genome.numericValues, genome.choiceIndices]);
}
