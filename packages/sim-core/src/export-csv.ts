/**
 * The history CSV exporter (law S7): uniformly sampled series export as
 * deterministic CSV — LF line endings, one `name (unit)` header cell per
 * column, one row per sample index, the shared deterministic float
 * formatter, trailing newline. The dialect never needs quoting: names
 * and units containing a comma, quote, or newline decline structured
 * (the parameter-table CSV's "no field ever needs quoting" discipline),
 * so identical tables always export to identical bytes.
 */

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { formatSimFloat } from "./format";
import { type SimParseResult, simFail, simOk } from "./result";

/** One history column: a name, its unit, and its samples. */
export interface SimHistoryColumn {
  readonly name: string;
  readonly unit: string;
  readonly samples: readonly number[];
}

/** A table of uniformly sampled columns (column 0 is conventionally time). */
export interface SimHistoryTable {
  readonly columns: readonly SimHistoryColumn[];
}

/** Whether a header label can ride the quoting-free dialect. */
function isBareLabel(value: string): boolean {
  return !/[",\r\n]/.test(value);
}

/**
 * Exports a history table as deterministic CSV. All columns must carry
 * the same sample count; values render through the shared deterministic
 * formatter.
 */
export function exportSimHistoryCsv(
  table: SimHistoryTable,
): SimParseResult<string, SimError> {
  if (table.columns.length === 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.quantityInvalid,
        "A history CSV export needs at least one column.",
        table,
      ),
    );
  }
  const sampleCount = table.columns[0]?.samples.length ?? 0;
  for (const column of table.columns) {
    if (column.samples.length !== sampleCount) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          `The history column "${column.name}" carries ${String(column.samples.length)} samples against ${String(sampleCount)}; a table's columns must be uniformly sampled.`,
          column,
        ),
      );
    }
    if (
      typeof column.name !== "string" ||
      column.name.length === 0 ||
      !isBareLabel(column.name) ||
      typeof column.unit !== "string" ||
      !isBareLabel(column.unit)
    ) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          "A history column's name and unit must be non-empty labels free of commas, quotes, and newlines (the quoting-free dialect).",
          column,
        ),
      );
    }
    for (const value of column.samples) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return simFail(
          simError(
            SIM_ERROR_CODES.quantityInvalid,
            `The history column "${column.name}" carries a non-finite sample.`,
            value,
          ),
        );
      }
    }
  }
  const header = table.columns
    .map((column) => `${column.name} (${column.unit})`)
    .join(",");
  const lines: string[] = [header];
  for (let index = 0; index < sampleCount; index += 1) {
    lines.push(
      table.columns
        .map((column) => formatSimFloat(column.samples[index] ?? 0))
        .join(","),
    );
  }
  return simOk(`${lines.join("\n")}\n`);
}
