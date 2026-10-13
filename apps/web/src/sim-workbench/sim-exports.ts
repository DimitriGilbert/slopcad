/**
 * The workbench's result exports (Phase 63c, law S7): deterministic file
 * content from a stored run — the decimated `.vti` field series through
 * the 61 exporter's decimated twin (the factor stated in each file's
 * `decimation` FieldData, never hidden), and the force-history CSV
 * through the 61 CSV exporter with the step column first. Bytes are
 * deterministic: the same stored result exports to the identical files
 * every time, pinned by test.
 */

import type { SimResult } from "@slopcad/sim-core";
import {
  exportSimFieldVtiDecimated,
  exportSimHistoryCsv,
} from "@slopcad/sim-core";

/** One exported file: its deterministic filename and text content. */
export interface SimExportFile {
  readonly filename: string;
  readonly text: string;
}

/**
 * The default export decimation: factor 2 keeps ParaView files small on
 * large lattices while the FieldData marker keeps the thinning honest;
 * factor 1 exports full fidelity. Both are honest — the marker says so.
 */
export const SIM_EXPORT_DEFAULT_VTI_DECIMATION = 2;

/** The safe filename form of a scenario label (ids are conservative already). */
function filenameStem(label: string): string {
  const cleaned = label.trim().replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned.length === 0 ? "run" : cleaned;
}

/**
 * Exports one run's field series as decimated `.vti` documents: one file
 * per field block, named `<scenario>-<field>-<decimation>x.vti`, with
 * the factor stated in the file's `decimation` FieldData metadata.
 */
export function exportSimResultVtiSeries(
  result: SimResult,
  decimation: number = SIM_EXPORT_DEFAULT_VTI_DECIMATION,
): readonly SimExportFile[] {
  const stem = filenameStem(result.summary.scenarioSnapshotHash);
  const files: SimExportFile[] = [];
  for (const field of result.fields) {
    const exported = exportSimFieldVtiDecimated(field, decimation);
    if (!exported.ok) continue; // a malformed block declines; the rest export.
    files.push({
      filename: `${stem}-${field.id}-dec${String(decimation)}.vti`,
      text: exported.value,
    });
  }
  return files;
}

/**
 * Exports one run's force histories as deterministic CSV: a step column
 * first, then every history series as its own column (`name (unit)`
 * headers). Returns `null` when the run carries no histories (nothing
 * to export — never a fabricated table).
 */
export function exportSimResultForceHistoryCsv(
  result: SimResult,
): string | null {
  if (result.histories.length === 0) return null;
  const first = result.histories[0];
  if (first === undefined) return null;
  const sampleCount = first.samples.length;
  const steps: number[] = [];
  for (let step = 1; step <= sampleCount; step += 1) steps.push(step);
  const exported = exportSimHistoryCsv({
    columns: [
      { name: "step", unit: "1", samples: steps },
      ...result.histories.map((series) => ({
        name: series.name,
        unit: series.unit,
        samples: [...series.samples],
      })),
    ],
  });
  return exported.ok ? exported.value : null;
}

/**
 * Exports one run's JOINT histories as deterministic CSV (Phase 67c,
 * law S7): a time column first (seconds — the sample cadence's own
 * clock), then every joint series (positions, rates, dissipated
 * power/work per joint). Returns `null` when the run carries no joint
 * series (nothing to export — never a fabricated table).
 */
export function exportSimResultJointHistoryCsv(
  result: SimResult,
): string | null {
  const jointSeries = result.histories.filter((series) =>
    series.name.startsWith("joint:"),
  );
  if (jointSeries.length === 0) return null;
  const time = result.histories.find((series) => series.name === "time");
  if (time === undefined) return null;
  const exported = exportSimHistoryCsv({
    columns: [
      { name: "time", unit: time.unit, samples: [...time.samples] },
      ...jointSeries.map((series) => ({
        name: series.name,
        unit: series.unit,
        samples: [...series.samples],
      })),
    ],
  });
  return exported.ok ? exported.value : null;
}

/**
 * Exports one combustion run's tables as deterministic CSV files
 * (Phase 68c, law S7): the ENGINE mode's P-vs-crank trace (the
 * crank-angle column first, then every cycle series) plus, when the
 * run swept, the sweep table (the axis column first, then every sweep
 * series); the STOVE mode's fire march (the time column first, then
 * the fire and field series). Empty when the run is neither — never a
 * fabricated table.
 */
export function exportSimResultCombustionCsvs(
  result: SimResult,
): readonly SimExportFile[] {
  const stem = filenameStem(result.summary.scenarioSnapshotHash);
  const files: SimExportFile[] = [];
  const cycleSeries = result.histories.filter(
    (series) => !series.name.startsWith("sweep:"),
  );
  const angle = cycleSeries.find((series) => series.name === "crank-angle");
  const time = cycleSeries.find((series) => series.name === "time");
  const leading = angle ?? time;
  if (leading !== undefined && cycleSeries.length > 1) {
    const ordered = [
      leading,
      ...cycleSeries.filter((series) => series.name !== leading.name),
    ];
    const exported = exportSimHistoryCsv({
      columns: ordered.map((series) => ({
        name: series.name,
        unit: series.unit,
        samples: [...series.samples],
      })),
    });
    if (exported.ok) {
      files.push({
        filename: `${stem}-${angle === undefined ? "fire" : "cycle"}.csv`,
        text: exported.value,
      });
    }
  }
  const sweepSeries = result.histories.filter((series) =>
    series.name.startsWith("sweep:"),
  );
  if (sweepSeries.length > 0) {
    // The axis column: `engine-sweeps` emits the kind's own axis
    // column first in its history table (the spark-timing / CR / φ
    // column ahead of imep and the rest), so the first prefixed
    // `sweep:` series IS the axis — taken unconditionally on that
    // emission order.
    const axis = sweepSeries[0];
    if (axis !== undefined) {
      const ordered = [
        axis,
        ...sweepSeries.filter((series) => series.name !== axis.name),
      ];
      const exported = exportSimHistoryCsv({
        columns: ordered.map((series) => ({
          name: series.name,
          unit: series.unit,
          samples: [...series.samples],
        })),
      });
      if (exported.ok) {
        files.push({ filename: `${stem}-sweep.csv`, text: exported.value });
      }
    }
  }
  return files;
}

/** Triggers a browser download of the exported files (best-effort UI sugar). */
export function downloadSimExportFiles(files: readonly SimExportFile[]): void {
  for (const file of files) {
    const url = URL.createObjectURL(
      new Blob([file.text], { type: "text/plain" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.filename;
    anchor.click();
    URL.revokeObjectURL(url);
  }
}
