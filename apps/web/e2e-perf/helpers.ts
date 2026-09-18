/**
 * The Phase 29 perf harness's shared driver-side tooling: percentile
 * statistics over the raw sample arrays the fixtures publish, the budgets
 * gate, and the machine-readable results writer. Kept driver-side on
 * purpose — the fixtures publish RAW samples only; aggregation happens
 * once, here, with one definition of median and percentile spread.
 *
 * Percentile method: nearest-rank on the ascending sort (index
 * `ceil(p * n) - 1`, clamped), the method the docs record beside every
 * number. Spread is reported as p10–p90.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";

/** Where the latest perf run's machine-readable results are written. */
const RESULTS_PATH = "e2e-artifacts/perf/perf-results.json";

/** Where the recorded budgets live (the docs carry the rationale). */
const BUDGETS_PATH = "e2e-perf/budgets.json";

/** One metric's aggregate. */
interface MetricStats {
  readonly n: number;
  readonly median: number;
  readonly p10: number;
  readonly p90: number;
  readonly max: number;
}

/** Aggregates raw samples (milliseconds) into the reported stats. */
function aggregate(samples: readonly number[]): MetricStats {
  if (samples.length === 0) {
    throw new Error("A perf metric must carry at least one sample.");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (index: number): number => {
    const value = sorted[index];
    if (value === undefined) {
      throw new Error("A percentile index landed outside the sample array.");
    }
    return value;
  };
  const rank = (p: number): number =>
    at(
      Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(p * sorted.length) - 1),
      ),
    );
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
  return {
    n: sorted.length,
    median,
    p10: rank(0.1),
    p90: rank(0.9),
    max: at(sorted.length - 1),
  };
}

/** The budgets file's shape: metric name → budget in milliseconds. */
type PerfBudgets = Readonly<Record<string, number>>;

/** One budget decision. */
export interface BudgetVerdict {
  readonly metric: string;
  readonly budgetMs: number;
  readonly median: number;
  readonly status: "ok" | "blown";
}

/**
 * Loads the recorded budgets. The file MUST exist — a missing file would
 * silently turn the gate into a report-only run, so its absence fails the
 * suite instead.
 */
export function loadBudgets(): PerfBudgets {
  const raw = readFileSync(BUDGETS_PATH, "utf8");
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${BUDGETS_PATH} must be a JSON object of metric → ms.`);
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  for (const [metric, budget] of entries) {
    if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
      throw new Error(
        `${BUDGETS_PATH}: the budget for "${metric}" must be a positive finite number.`,
      );
    }
  }
  if (entries.length === 0) {
    throw new Error(
      `${BUDGETS_PATH} is empty — an empty budgets file would turn the gate green without measuring anything.`,
    );
  }
  return Object.fromEntries(entries) as PerfBudgets;
}

/**
 * The gate itself: every budgeted metric in `stats` must have its median
 * at or under the budget. Returns the verdicts; throws (failing the spec)
 * listing every blown budget.
 */
export function enforceBudgets(
  stats: Readonly<Record<string, MetricStats>>,
  budgets: PerfBudgets,
): readonly BudgetVerdict[] {
  const verdicts: BudgetVerdict[] = [];
  const blown: string[] = [];
  for (const [metric, budgetMs] of Object.entries(budgets)) {
    const statsEntry = stats[metric];
    if (statsEntry === undefined) {
      throw new Error(
        `The budgeted metric "${metric}" was not measured by this run — the fixture and the budgets file have drifted apart.`,
      );
    }
    const status: BudgetVerdict["status"] =
      statsEntry.median <= budgetMs ? "ok" : "blown";
    if (status === "blown") {
      blown.push(
        `${metric}: median ${statsEntry.median.toFixed(2)} ms > budget ${String(budgetMs)} ms (p90 ${statsEntry.p90.toFixed(2)} ms, n=${String(statsEntry.n)})`,
      );
    }
    verdicts.push({ metric, budgetMs, median: statsEntry.median, status });
  }
  if (blown.length > 0) {
    throw new Error(`Performance budgets blown:\n  ${blown.join("\n  ")}`);
  }
  return verdicts;
}

/** The driver-side environment block recorded with every run. */
export function driverEnvironment(): Record<string, unknown> {
  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    memoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
  };
}

/** One metric's full record: the aggregate plus the raw samples. */
export type MetricRecord = MetricStats & {
  readonly samples: readonly number[];
};

/** The whole run's machine-readable record. */
export interface PerfRunRecord {
  readonly runAt: string;
  readonly driver: Record<string, unknown>;
  readonly browser: Record<string, unknown> | null;
  readonly geometry: Record<string, unknown> | null;
  readonly metrics: Readonly<Record<string, MetricRecord>>;
  readonly budgets: readonly BudgetVerdict[];
}

/**
 * Merges metric stats into a record (keeping previously collected metrics)
 * and returns the record with fresh aggregate entries appended.
 */
export function recordMetrics(
  record: PerfRunRecord,
  samples: Readonly<Record<string, readonly number[]>>,
): PerfRunRecord {
  const metrics: Record<string, MetricRecord> = { ...record.metrics };
  for (const [metric, values] of Object.entries(samples)) {
    metrics[metric] = { ...aggregate(values), samples: values };
  }
  return { ...record, metrics };
}

/**
 * Writes the run record (merging with a record already written by the
 * OTHER spec of this suite — one machine-readable file per run) and prints
 * a human table row per metric.
 */
export async function writeResults(record: PerfRunRecord): Promise<void> {
  await mkdir("e2e-artifacts/perf", { recursive: true });
  const existing = await readExisting();
  const merged: PerfRunRecord = {
    ...record,
    browser: record.browser ?? existing?.browser ?? null,
    geometry: record.geometry ?? existing?.geometry ?? null,
    metrics:
      existing === null
        ? record.metrics
        : { ...existing.metrics, ...record.metrics },
    budgets:
      existing === null
        ? record.budgets
        : [
            ...existing.budgets.filter(
              (v) => !record.budgets.some((b) => b.metric === v.metric),
            ),
            ...record.budgets,
          ],
  };
  await writeFile(RESULTS_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  for (const [metric, stats] of Object.entries(record.metrics)) {
    const budget = record.budgets.find((v) => v.metric === metric);
    const budgetText =
      budget === undefined
        ? ""
        : ` | budget ${String(budget.budgetMs)} ms ${budget.status}`;
    console.log(
      `  ${metric}: median ${stats.median.toFixed(2)} ms, p10 ${stats.p10.toFixed(2)} / p90 ${stats.p90.toFixed(2)} ms, n=${String(stats.n)}${budgetText}`,
    );
  }
}

/** The record a previous spec of this suite already wrote, if any. */
async function readExisting(): Promise<PerfRunRecord | null> {
  try {
    const raw = await readFile(RESULTS_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as PerfRunRecord;
  } catch {
    return null;
  }
}
