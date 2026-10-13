/**
 * The Phase 64b WebGPU spike spec: the S5 oracle-vs-GPU tolerance
 * matrix under a REAL WebGPU device (Dawn's SwiftShader software
 * adapter on headless Linux — the launch door this harness's config
 * carries). Asserts the 64a recorded tolerances hold for EVERY case
 * and EVERY repeat the fixture ran, that no kernel diverged, and —
 * the stability half of the adopt/decline decision — that a second
 * full matrix run (the fixture's "Run again") holds them too. The
 * numbers print to the run log: they are the findings doc's evidence
 * (`docs/architecture/wgsl-prespike-findings.md`), re-derivable by
 * re-running `pnpm test:gpu-spike`.
 *
 * A device absence FAILS here (this harness's flag guarantees one on a
 * compliant host) with the fixture's loud skip reason in the message —
 * the spike door never silently passes; the headless unit suites stay
 * the skip-loudly path for GPU-less hosts (law S5).
 */

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/** The published spike report's shape (the fixture's JSON surface). */
interface SpikeReport {
  readonly phase: string;
  readonly adapter: {
    readonly vendor: string;
    readonly architecture: string;
    readonly device: string;
    readonly description: string;
  } | null;
  readonly deviceAbsent: boolean;
  readonly skipReason: string | null;
  readonly repeatsPerCase: number;
  readonly cases: readonly {
    readonly id: string;
    readonly steps: number;
    readonly diverged: boolean;
    readonly repeats: readonly {
      readonly l2Relative: Readonly<Record<string, number>>;
      readonly linfRelative: Readonly<Record<string, number>>;
      readonly violations: readonly string[];
    }[];
  }[];
  readonly error: string | null;
}

/** Reads, parses, and demands a SETTLED (done-or-failed) report from the page. */
async function readReport(page: Page): Promise<SpikeReport> {
  await page.waitForFunction(
    () => {
      const phase = document
        .getElementById("sim-gpu-root")
        ?.getAttribute("data-sim-gpu-phase");
      return phase === "done" || phase === "failed";
    },
    undefined,
    { timeout: 90_000, polling: 100 },
  );
  const raw = await page
    .locator("#sim-gpu-root")
    .getAttribute("data-sim-gpu-report");
  expect(raw, "the spike fixture must publish its report").not.toBeNull();
  if (raw === null) throw new Error("unreachable: report checked above");
  return JSON.parse(raw) as SpikeReport;
}

/** The shared verdict: adapter provenance, no divergence, tolerances held. */
function assertMatrixHeld(report: SpikeReport): void {
  expect(report.error).toBeNull();
  if (report.deviceAbsent) {
    throw new Error(
      `The gpu-spike harness found no WebGPU device despite its launch flag — the S5 GPU door is broken on this host. Fixture reason: ${report.skipReason ?? "none recorded"}`,
    );
  }
  // Provenance: the adapter class is recorded (Dawn SwiftShader here).
  expect(report.adapter).not.toBeNull();
  console.log(
    `  adapter: ${report.adapter?.vendor ?? "?"} / ${report.adapter?.architecture ?? "?"}`,
  );
  expect(report.repeatsPerCase).toBeGreaterThanOrEqual(2);
  expect(report.cases.length).toBeGreaterThanOrEqual(3);
  for (const entry of report.cases) {
    expect(
      entry.diverged,
      `${entry.id}: a kernel diverged — the comparison is void`,
    ).toBe(false);
    expect(entry.repeats.length).toBe(report.repeatsPerCase);
    for (const [index, repeat] of entry.repeats.entries()) {
      expect(
        repeat.violations,
        `${entry.id} repeat ${String(index)}: tolerance violations`,
      ).toEqual([]);
      const worstL2 = Math.max(...Object.values(repeat.l2Relative));
      const worstLinf = Math.max(...Object.values(repeat.linfRelative));
      console.log(
        `  ${entry.id} repeat ${String(index)}: worst L2 ${worstL2.toExponential(3)}, worst L∞ ${worstLinf.toExponential(3)} (drag L2 ${repeat.l2Relative.drag?.toExponential(3) ?? "?"}, lift L∞ ${repeat.linfRelative.lift?.toExponential(3) ?? "?"})`,
      );
    }
  }
}

test("the oracle-vs-GPU matrix holds its recorded tolerances under a real WebGPU device", async ({
  page,
}) => {
  await page.goto("/sim-gpu");
  const first = await readReport(page);
  assertMatrixHeld(first);

  // The stability half of the decision: a SECOND full matrix run on a
  // fresh device request must hold the same tolerances.
  await page.locator("#sim-gpu-rerun").click();
  const second = await readReport(page);
  assertMatrixHeld(second);

  // Cross-run drift summary (informational, printed for the findings
  // doc; the per-repeat tolerance gate above is the verdict).
  for (const [caseIndex, entry] of second.cases.entries()) {
    const firstCase = first.cases[caseIndex];
    if (firstCase === undefined || firstCase.id !== entry.id) continue;
    const drift = entry.repeats.map((repeat, repeatIndex) => {
      const before = firstCase.repeats[repeatIndex];
      const after = repeat.l2Relative.distribution;
      const beforeValue = before?.l2Relative.distribution;
      if (after === undefined || beforeValue === undefined) return Number.NaN;
      return Math.abs(after - beforeValue);
    });
    console.log(
      `  ${entry.id} run-to-run distribution-L2 drift: ${drift.map((value) => (Number.isNaN(value) ? "n/a" : value.toExponential(1))).join(", ")}`,
    );
  }
});
