/**
 * The `/sim-gpu` fixture page (Phase 64b's WebGPU spike door): runs the
 * S5 oracle-vs-GPU tolerance matrix IN-PAGE against the production
 * build's WGSL provider, on whatever WebGPU device the host exposes,
 * and publishes the whole spike record as JSON on the root's
 * `data-sim-gpu-report` attribute (`data-sim-gpu-phase` carries the
 * phase). The Playwright gpu-spike harness collects and asserts it; a
 * GPU-less host records the LOUD SKIP (the 64a harness's own reason)
 * — never a fabricated pass (law S5).
 *
 * No canvas, no worker: the matrix is the 64a harness itself over the
 * provider seam, main-thread. The "Run again" button re-runs the whole
 * matrix through a fresh device request (the perf fixture's rerun
 * precedent) — the spike's cross-run stability probe.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";

import {
  readSimGpuAdapterProvenance,
  runSimGpuOracleMatrix,
  type SimGpuOracleRunReport,
} from "./sim-gpu-oracle-run";

const EMPTY_REPORT: SimGpuOracleRunReport = {
  phase: "running",
  adapter: null,
  deviceAbsent: false,
  skipReason: null,
  repeatsPerCase: 0,
  cases: [],
  error: null,
};

export function SimGpuOraclePage(): ReactElement {
  const [report, setReport] = useState<SimGpuOracleRunReport>(EMPTY_REPORT);
  // One live run at a time (the perf fixture's rerun guard).
  const runInFlightRef = useRef(false);

  const runMatrix = useCallback(async (): Promise<void> => {
    if (runInFlightRef.current) return;
    runInFlightRef.current = true;
    setReport(EMPTY_REPORT);
    try {
      const adapter = await readSimGpuAdapterProvenance();
      setReport(await runSimGpuOracleMatrix({ adapter }));
    } finally {
      runInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void runMatrix();
  }, [runMatrix]);

  const caseLines = report.cases.map((entry) => {
    const worst = entry.repeats.reduce(
      (max, repeat) => Math.max(max, ...Object.values(repeat.l2Relative)),
      0,
    );
    return `${entry.id} ×${String(entry.repeats.length)} — worst repeat L2 ${worst.toPrecision(3)}${entry.diverged ? " (DIVERGED)" : ""}`;
  });

  return (
    <div
      id="sim-gpu-root"
      className="mx-auto w-full max-w-4xl space-y-4 p-6"
      data-sim-gpu-phase={report.phase}
      data-sim-gpu-report={JSON.stringify(report)}
    >
      <div>
        <h1 className="text-lg font-semibold">
          WebGPU Oracle-vs-GPU Spike Fixture (Phase 64b)
        </h1>
        <p className="text-muted-foreground text-sm">
          The S5 tolerance matrix (law S5: the CPU oracle is the test truth)
          executed by the production WGSL provider on this host's WebGPU device.
          The full record publishes as JSON on this root's data-sim-gpu-report
          attribute; a GPU-less host records the loud skip, never a pass.
        </p>
      </div>
      <div className="space-y-1 font-mono text-xs">
        <div>
          phase ={" "}
          <span id="sim-gpu-phase">
            {report.phase}
            {report.deviceAbsent ? " (no device — skipped loudly)" : ""}
          </span>
        </div>
        <div>
          adapter ={" "}
          <span id="sim-gpu-adapter">
            {report.adapter === null
              ? "none (navigator.gpu absent)"
              : `${report.adapter.vendor} / ${report.adapter.architecture}${report.adapter.device === "" ? "" : ` / ${report.adapter.device}`}`}
          </span>
        </div>
        <div>
          repeats per case ={" "}
          <span id="sim-gpu-repeats">{String(report.repeatsPerCase)}</span>
        </div>
        {report.skipReason === null ? null : (
          <li data-testid="sim-gpu-skip" className="text-amber-600">
            {report.skipReason}
          </li>
        )}
        {report.error === null ? null : (
          <li data-testid="sim-gpu-error" className="text-red-500">
            {report.error}
          </li>
        )}
        <ul className="space-y-0.5">
          {caseLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div>
          <button
            id="sim-gpu-rerun"
            className="border-input bg-background rounded border px-2 py-1 disabled:cursor-not-allowed disabled:opacity-50"
            type="button"
            disabled={report.phase === "running"}
            onClick={() => {
              void runMatrix();
            }}
          >
            Run again
          </button>
        </div>
      </div>
    </div>
  );
}
