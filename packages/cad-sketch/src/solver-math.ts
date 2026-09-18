/**
 * Hand-rolled dense linear algebra for the reference solver — no external
 * dependencies, deterministic IEEE-754 arithmetic, and matrices laid out as
 * row arrays of column arrays in a fixed order derived from the parameter
 * layout, so identical inputs always produce identical outputs bit-for-bit.
 *
 * Three operations:
 *
 * - `rankOf` — the rank of an m×n matrix via Gaussian elimination with
 *   partial pivoting; pivots at or below `tolerance` (relative to the largest
 *   pivot seen) count as zero. Used on the residual Jacobian at the solution
 *   to count independent constraint directions → degrees of freedom.
 * - `solveLeastSquaresStep` — one Gauss-Newton step: solve the symmetric
 *   normal equations `(JᵀJ)δ = −Jᵀr` with rank-aware elimination. Directions
 *   whose pivots vanish are unconstrained: their step component is exactly
 *   zero, which is what leaves under-constrained geometry at its drawn
 *   position instead of drifting.
 * - `dependentRowFlags` — which rows are linear combinations of earlier
 *   rows, used to name the redundant constraint equations of a solved
 *   system.
 */

class MatrixShapeError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = "MatrixShapeError";
  }
}

function requireRow(matrix: number[][], index: number): number[] {
  const row = matrix[index];
  if (row === undefined) {
    throw new MatrixShapeError(`Matrix is missing row ${index}.`);
  }
  return row;
}

function requireEntry(row: number[], index: number): number {
  const value = row[index];
  if (value === undefined) {
    throw new MatrixShapeError(`Matrix row is missing column ${index}.`);
  }
  return value;
}

function copyMatrix(matrix: readonly (readonly number[])[]): number[][] {
  return matrix.map((row) => [...row]);
}

/**
 * Forward elimination shared by `rankOf` and `dependentRowFlags`: reduces the
 * matrix in place with partial pivoting, swapping physical rows while
 * `originalIndices` tracks where each reduced row came from. Returns the
 * number of pivot rows found. With `preferLargest` the pivot is the largest
 * remaining entry in the column (best numerics, as rank computation wants);
 * otherwise it is the first entry above the tolerance, so a row only ever
 * becomes a pivot when no earlier row can — which is what makes the
 * dependent-row flags mean "a combination of earlier rows".
 */
function eliminate(
  a: number[][],
  originalIndices: number[],
  tolerance: number,
  preferLargest: boolean,
): number {
  const rows = a.length;
  const cols = rows === 0 ? 0 : requireRow(a, 0).length;
  let maxPivot = 0;
  let head = 0;
  let rank = 0;
  for (let col = 0; col < cols && head < rows; col += 1) {
    const threshold = tolerance * Math.max(1, maxPivot);
    let pivotRow = -1;
    let pivotValue = 0;
    for (let candidate = head; candidate < rows; candidate += 1) {
      const value = Math.abs(requireEntry(requireRow(a, candidate), col));
      if (value <= threshold) continue;
      if (preferLargest ? value > pivotValue : pivotRow < 0) {
        pivotRow = candidate;
        pivotValue = value;
      }
    }
    if (pivotRow < 0) continue;
    if (pivotValue > maxPivot) maxPivot = pivotValue;
    if (pivotRow !== head) {
      const swap = requireRow(a, head);
      a[head] = requireRow(a, pivotRow);
      a[pivotRow] = swap;
      const swapIndex = originalIndices[head];
      const headIndex = originalIndices[pivotRow];
      if (swapIndex === undefined || headIndex === undefined) {
        throw new MatrixShapeError("Row index tracking is incomplete.");
      }
      originalIndices[head] = headIndex;
      originalIndices[pivotRow] = swapIndex;
    }
    const pivotRowValues = requireRow(a, head);
    const pivot = requireEntry(pivotRowValues, col);
    for (let target = head + 1; target < rows; target += 1) {
      const targetValues = requireRow(a, target);
      const factor = requireEntry(targetValues, col) / pivot;
      if (factor === 0) continue;
      for (let c = col; c < cols; c += 1) {
        const current = requireEntry(targetValues, c);
        const pivotColumnValue = requireEntry(pivotRowValues, c);
        targetValues[c] = current - factor * pivotColumnValue;
      }
    }
    head += 1;
    rank += 1;
  }
  return rank;
}

/** Rank of `matrix` (m rows × n cols) under a relative pivot tolerance. */
export function rankOf(
  matrix: readonly (readonly number[])[],
  tolerance: number,
): number {
  if (matrix.length === 0) return 0;
  return eliminate(
    copyMatrix(matrix),
    Array.from({ length: matrix.length }, (_, i) => i),
    tolerance,
    true,
  );
}

/**
 * Identifies which rows of a matrix are linear combinations of the rows
 * before them (the redundant set), using the same elimination and tolerance
 * as {@link rankOf}. Returns a boolean per row: `true` marks a dependent row.
 * Callers converge the residual first, so every dependent row found here is
 * consistent — redundant, not conflicting.
 */
export function dependentRowFlags(
  matrix: readonly (readonly number[])[],
  tolerance: number,
): boolean[] {
  const rows = matrix.length;
  const flags = new Array<boolean>(rows).fill(false);
  if (rows === 0) return flags;
  const originalIndices = Array.from({ length: rows }, (_, i) => i);
  const rank = eliminate(copyMatrix(matrix), originalIndices, tolerance, false);
  const pivotedOriginals = new Set(originalIndices.slice(0, rank));
  for (let i = 0; i < rows; i += 1) {
    flags[i] = !pivotedOriginals.has(i);
  }
  return flags;
}

/**
 * A Gauss-Newton step from the normal equations. `jacobianRows` are the
 * residual Jacobian rows (sparse gradients as slot→coefficient maps over
 * `parameterCount` parameters) and `residuals` the matching values. Returns
 * the step and the rank of the (eliminated) normal matrix. Zero directions in
 * `JᵀJ` produce a zero step component by construction.
 */
export function solveLeastSquaresStep(
  jacobianRows: readonly (ReadonlyMap<number, number> | undefined)[],
  residuals: readonly number[],
  parameterCount: number,
  pivotTolerance: number,
): { readonly step: number[]; readonly rank: number } {
  const n = parameterCount;
  const m = residuals.length;
  if (n === 0) return { step: [], rank: 0 };
  // A = JᵀJ (n×n), b = −Jᵀr (n).
  const a: number[][] = Array.from({ length: n }, () =>
    new Array<number>(n).fill(0),
  );
  const b: number[] = new Array<number>(n).fill(0);
  for (let i = 0; i < m; i += 1) {
    const row = jacobianRows[i];
    const r = residuals[i];
    if (row === undefined || r === undefined) continue;
    for (const [slotA, coeffA] of row) {
      if (coeffA === 0) continue;
      const aRow = requireRow(a, slotA);
      aRow[slotA] = requireEntry(aRow, slotA) + coeffA * coeffA;
      b[slotA] = requireEntry(b, slotA) - coeffA * r;
      for (const [slotB, coeffB] of row) {
        if (slotB === slotA || coeffB === 0) continue;
        aRow[slotB] = requireEntry(aRow, slotB) + coeffA * coeffB;
      }
    }
  }
  // Gaussian elimination with partial pivoting on the augmented [A | b];
  // pivots below the absolute tolerance mark a direction as unconstrained.
  let maxDiagonal = 0;
  for (let i = 0; i < n; i += 1) {
    const diagonal = Math.abs(requireEntry(requireRow(a, i), i));
    if (diagonal > maxDiagonal) maxDiagonal = diagonal;
  }
  const tolerance = pivotTolerance * Math.max(1, maxDiagonal);
  const x: number[] = new Array<number>(n).fill(0);
  const pivots: { slot: number; row: number }[] = [];
  const claimed = new Array<boolean>(n).fill(false);
  let rank = 0;
  let head = 0;
  for (let round = 0; round < n; round += 1) {
    // Find the largest remaining pivot in the uneliminated submatrix.
    let pivotRow = -1;
    let pivotCol = -1;
    let pivotValue = tolerance;
    for (let i = head; i < n; i += 1) {
      const rowValues = requireRow(a, i);
      for (let j = 0; j < n; j += 1) {
        if (claimed[j]) continue;
        const value = Math.abs(requireEntry(rowValues, j));
        if (value > pivotValue) {
          pivotValue = value;
          pivotRow = i;
          pivotCol = j;
        }
      }
    }
    if (pivotRow < 0) break;
    if (pivotRow !== head) {
      const swap = requireRow(a, head);
      a[head] = requireRow(a, pivotRow);
      a[pivotRow] = swap;
      const swapB = b[head];
      const headB = b[pivotRow];
      if (headB === undefined || swapB === undefined) {
        throw new MatrixShapeError("Right-hand side is incomplete.");
      }
      b[head] = headB;
      b[pivotRow] = swapB;
    }
    const pivotRowValues = requireRow(a, head);
    const pivot = requireEntry(pivotRowValues, pivotCol);
    for (let i = head + 1; i < n; i += 1) {
      const rowValues = requireRow(a, i);
      const factor = requireEntry(rowValues, pivotCol) / pivot;
      if (factor === 0) continue;
      for (let j = 0; j < n; j += 1) {
        if (claimed[j] && j !== pivotCol) continue;
        const current = requireEntry(rowValues, j);
        const pivotColumnValue = requireEntry(pivotRowValues, j);
        rowValues[j] = current - factor * pivotColumnValue;
      }
      const bi = requireEntry(b, i);
      const bh = requireEntry(b, head);
      b[i] = bi - factor * bh;
    }
    pivots.push({ slot: pivotCol, row: head });
    claimed[pivotCol] = true;
    head += 1;
    rank += 1;
  }
  // Back-substitution in reverse pivot order; unconstrained slots stay 0.
  for (let k = pivots.length - 1; k >= 0; k -= 1) {
    const entry = pivots[k];
    if (entry === undefined) continue;
    const row = requireRow(a, entry.row);
    let sum = requireEntry(b, entry.row);
    for (let later = k + 1; later < pivots.length; later += 1) {
      const laterEntry = pivots[later];
      if (laterEntry === undefined) continue;
      const coefficient = requireEntry(row, laterEntry.slot);
      sum -= coefficient * requireEntry(x, laterEntry.slot);
    }
    x[entry.slot] = sum / requireEntry(row, entry.slot);
  }
  return { step: x, rank };
}
