/**
 * The perf harness's global setup: resets the run's machine-readable
 * artifact. The two specs MERGE their metrics into
 * `e2e-artifacts/perf/perf-results.json`, so a file left by an earlier run
 * would leak its (possibly renamed) metric keys into this run's record —
 * each run starts from a clean file.
 */

import { rm } from "node:fs/promises";

export default async function globalSetup(): Promise<void> {
  await rm("e2e-artifacts/perf/perf-results.json", { force: true });
}
