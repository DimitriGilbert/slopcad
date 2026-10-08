/**
 * The `/workbench-sim` fixture page (ROADMAP-SIM Phase 62c, extended
 * 63c — the flow ENGINE + PRODUCT SURFACE — and 63d — the run
 * COMPARISON SURFACE).
 *
 * ## Phase 62 (unchanged): "here is your part as a grid"
 *
 * The cad-jsx demo model (`@slopcad/docs-examples`'s `cadjsx/
 * sim-demo-body`) compiles and folds into a parametric document; the
 * real Manifold kernel executing in a real module Web Worker
 * tessellates it through the document-scene computation (the `/render`
 * fixture's session); the merged single-soup tessellation voxelizes
 * through `@slopcad/sim-core`'s voxelizer under the fixture's EXPLICIT
 * domain and a resolution preset (fixture data — law S3); and the
 * occupancy (or signed-distance) grid renders through the Phase 62b
 * overlay family (`FieldSlicePlane` + `FieldIsoContours`) in the
 * `CadScene` children slot.
 *
 * ## Phase 63c: the wind tunnel
 *
 * A Formedible flow-scenario form authors scenario records that land in
 * the document's `simulations` section (law S1); "Run" boots the real
 * sim worker (the routed engine: the 2D LBM reference kernel for flow)
 * and drives compile → run → finalize through the Phase 61 protocol,
 * with every notification applied through the Phase 61d ledger — the
 * `data-sim-*` counters advance only on committed applications, and the
 * overlays render the COMPLETED preview rounds' reassembled speed
 * blocks (law S6: overlay application IS committed application). The
 * completed run persists through the local SimResultStore (law S7,
 * IndexedDB, keyed by the scenario-snapshot hash), the run list shows
 * in the panel, and exports produce the decimated `.vti` field series
 * plus the force-history CSV with deterministic bytes.
 *
 * ## Phase 63d: the run comparison surface
 *
 * Two persisted runs selected from the run list (native selects — the
 * fixture-data precedent, no form) compare as exactly two views, the
 * risk-S17 boundary: the HISTORY-CURVE OVERLAY (both runs' drag/lift
 * vs step over one shared window per quantity) and the FIELD DIFF (the
 * same-field per-node difference rendered through the Phase 62 overlay
 * family with the diverging cool–warm colormap). The diff's chunk
 * round applies through the SAME committed-application ledger — the
 * `data-sim-*` counters advance on its commit, and the overlay mounts
 * only from the applied round.
 *
 * ## Machine-readable surface
 *
 * The render session's settle family (`data-dispatched`,
 * `data-settled`, `data-in-flight`, `data-current-revision`,
 * `data-applied-revision`, `data-volume`, `data-cad-rendered-volume`,
 * `data-error`) plus the sim family (`data-sim-applied-notifications`,
 * `data-sim-applied-field-chunks`, `data-sim-applied-progress-step`),
 * the applied-grid state (`data-sim-grid-state`,
 * `data-sim-grid-error`), the 63c run family:
 * `data-sim-scenario-count`, `data-sim-run-status` (idle | compiling |
 * running | finalizing | persisting | completed | failed),
 * `data-sim-run-count`, `data-sim-run-hash`, `data-sim-served-backend`
 * (the completed run's honest kernel record — "cpu" | "gpu" | ""),
 * `data-sim-export-vti`
 * (exported .vti file count), `data-sim-export-csv`, and the 63d
 * compare family: `data-sim-compare-status` (idle | comparing | ready |
 * failed), `data-sim-compare-runs` (`a:<id>|b:<id>`),
 * `data-sim-compare-diff` (the diffed field id once rendered),
 * `data-sim-compare-l2` (the relative L2 difference), and
 * `data-sim-compare-error`.
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CadScene, FieldIsoContours, FieldSlicePlane } from "@slopcad/cad-r3f";
import {
  addDocumentSimulation,
  serializeSimScenario,
  type CadDocument,
  type SimScenario,
  type SimScenarioDraft,
} from "@slopcad/cad-core";
import type { SimResultFieldBlock } from "@slopcad/sim-core";
import type { SimResultRunRecord } from "@slopcad/sim-core";
import type { SimResultStore } from "@slopcad/sim-core";
import type { SimResult } from "@slopcad/sim-core";
import type { BootedSimWorkerChannel } from "@slopcad/sim-core";
import type { DecodedFieldGrid } from "@slopcad/cad-r3f";
import {
  CAD_FIELD_COLORMAP_COOLWARM,
  CAD_FIELD_COLORMAP_VIRIDIS,
  decodedFieldGrid,
} from "@slopcad/cad-r3f";

import {
  bootRenderFixtureSession,
  type FixtureRenderState,
} from "../render-fixture/fixture-session";
import {
  documentSceneBodies,
  documentSceneTessellation,
  renderableBodyIds,
} from "../cad-workbench/document-scene";
import {
  createSimApplicationLedger,
  type SimAppliedCounters,
} from "../cad-workbench/sim-application-ledger";
import {
  applySimFixtureField,
  buildSimFixtureField,
  type SimFixtureControls,
  type SimFixtureOverlay,
  SIM_FIXTURE_BOOT_CONTROLS,
  simFixtureOccupiedNodes,
  simFixtureOverlayOf,
  SIM_FIXTURE_RESOLUTIONS,
  simDemoDocument,
  stampSimAppliedCounters,
} from "./sim-grid-fixture";
import { FlowScenarioForm } from "./flow-scenario-form";
import {
  type FlowRunOutcome,
  type FlowRunPhase,
  runFlowScenario,
} from "./flow-run";
import {
  applySimFieldDiff,
  type SimCurveOverlay,
  type SimFieldDiff,
  simCurveOverlayOf,
  simCurvePolylinePoints,
  simFieldDiffOf,
} from "./sim-compare";
import {
  downloadSimExportFiles,
  exportSimResultForceHistoryCsv,
  exportSimResultVtiSeries,
  type SimExportFile,
} from "./sim-exports";
import { createWorkbenchSimResultStore } from "./sim-result-store-web";
import { bootSimWorkbenchWorker } from "./sim-worker-host";

/** The settle root every attribute family lands on. */
const ROOT_ID = "workbench-sim-root";
/** The fixed-pixel viewport (the determinism contract's authored frame). */
const VIEWPORT_ID = "workbench-sim-viewport";
/** The document version the workbench's runs persist against. */
const DOCUMENT_VERSION_ID = "doc_workbench_sim";
/** The inlet speed the overlay window derives from, mm/s (the form default). */
const OVERLAY_INLET_MM_PER_S = 10;
/** The field the comparison diffs — the flow engine's own speed block. */
const COMPARE_FIELD_ID = "speed";
/** The curve overlay panel's deterministic geometry, px. */
const COMPARE_PANEL_WIDTH = 256;
const COMPARE_PANEL_HEIGHT = 64;

/**
 * The demo document and its scene requests — computed once at module
 * scope. Pure and deterministic (the compile walk and the request
 * derivation both are), so the page, the server render, and every test
 * load see the same document.
 */
const DEMO_DOCUMENT = simDemoDocument();
const DEMO_BODIES = documentSceneBodies(DEMO_DOCUMENT, new Set(), null);
const DEMO_RENDERABLE = renderableBodyIds(DEMO_DOCUMENT);

/** An applied document-scene settle: the render state plus its revision. */
interface AppliedScene {
  readonly state: FixtureRenderState;
  readonly revision: number;
}

/** The live-field overlay the run's completed preview rounds paint. */
interface LiveFieldOverlay {
  readonly field: DecodedFieldGrid;
  readonly slicePositionMm: number;
  readonly valueRange: readonly [number, number];
}

/** Derives the live overlay from a reassembled preview block. */
function liveOverlayOf(block: SimResultFieldBlock): LiveFieldOverlay {
  const decoded = decodedFieldGrid(block);
  return {
    field: decoded,
    slicePositionMm: decoded.originMm[2] ?? 0,
    valueRange: [0, OVERLAY_INLET_MM_PER_S],
  };
}

/** Which overlay the viewport paints — the last user action wins. */
type OverlayMode = "fixture" | "live" | "compare";

/** Derives the diff overlay from an applied comparison diff block. */
function diffOverlayOf(diff: SimFieldDiff): LiveFieldOverlay {
  const decoded = decodedFieldGrid(diff.block);
  return {
    field: decoded,
    slicePositionMm: decoded.originMm[2] ?? 0,
    valueRange: diff.valueRange,
  };
}

export function SimWorkbenchPage(): ReactElement {
  const [scene, setScene] = useState<AppliedScene | null>(null);
  const [controls, setControls] = useState<SimFixtureControls>(
    SIM_FIXTURE_BOOT_CONTROLS,
  );
  const [simError, setSimError] = useState("");
  const [simCounters, setSimCounters] = useState<SimAppliedCounters | null>(
    null,
  );
  const [overlay, setOverlay] = useState<SimFixtureOverlay | null>(null);
  const [gridState, setGridState] = useState("");
  const [renderedFrames, setRenderedFrames] = useState(0);
  const [simLedger] = useState(createSimApplicationLedger);
  // The application digest: one committed application per distinct
  // (scene settle, controls) — a re-render over the same inputs never
  // re-publishes a round.
  const appliedDigestRef = useRef("");

  // --- Phase 63c state ------------------------------------------------------
  const [workingDocument, setWorkingDocument] =
    useState<CadDocument>(DEMO_DOCUMENT);
  const [selectedScenario, setSelectedScenario] = useState<SimScenario | null>(
    null,
  );
  const [runStatus, setRunStatus] = useState<string>("idle");
  const [runs, setRuns] = useState<readonly SimResultRunRecord[]>([]);
  const [lastResult, setLastResult] = useState<SimResult | null>(null);
  const [liveOverlay, setLiveOverlay] = useState<LiveFieldOverlay | null>(null);
  const [exportedVti, setExportedVti] = useState(0);
  const [exportedCsv, setExportedCsv] = useState(0);
  // --- Phase 63d state (the run comparison surface) -------------------------
  const [overlayMode, setOverlayMode] = useState<OverlayMode>("fixture");
  const [compareRunA, setCompareRunA] = useState("");
  const [compareRunB, setCompareRunB] = useState("");
  const [compareStatus, setCompareStatus] = useState("idle");
  const [compareCurves, setCompareCurves] = useState<SimCurveOverlay | null>(
    null,
  );
  const [compareDiff, setCompareDiff] = useState<SimFieldDiff | null>(null);
  const [compareOverlay, setCompareOverlay] = useState<LiveFieldOverlay | null>(
    null,
  );
  const [compareError, setCompareError] = useState("");
  const channelRef = useRef<BootedSimWorkerChannel | null>(null);
  // The store-boot promise: a run awaits it, so a fast click after load
  // never races the IndexedDB open (it declines only on a real failure).
  const storeBootRef = useRef<Promise<SimResultStore | null>>(
    Promise.resolve(null),
  );
  const sceneRef = useRef<AppliedScene | null>(null);

  useEffect(() => {
    const session = bootRenderFixtureSession(
      {
        rootId: ROOT_ID,
        statusId: "workbench-sim-status",
        volumeId: "workbench-sim-volume",
        boundsId: "workbench-sim-bounds",
        trianglesId: "workbench-sim-triangles",
        errorId: "workbench-sim-error",
      },
      (state, revision) => {
        const applied: AppliedScene = { state, revision };
        sceneRef.current = applied;
        setScene(applied);
      },
    );
    session.dispatchDocument(DEMO_BODIES, DEMO_RENDERABLE);
    return () => {
      session.dispose();
    };
  }, []);

  // The run store boots with the page (the local backend; a decline
  // surfaces in the panel's error line, never a silent no-store).
  useEffect(() => {
    let cancelled = false;
    storeBootRef.current = createWorkbenchSimResultStore()
      .then((store) => {
        if (cancelled) return null;
        return store.list(DOCUMENT_VERSION_ID).then((listed) => {
          if (cancelled || !listed.ok) return store;
          setRuns(listed.value);
          return store;
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return null;
        setSimError(
          `sim/store-unavailable: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(
    () => () => {
      channelRef.current?.dispose();
    },
    [],
  );

  // The voxelization + committed-application effect: runs on every
  // settled scene or control change whose digest it has not yet
  // applied. The merged tessellation voxelizes under the fixture's
  // explicit domain; the grid's block publishes as a chunk stream
  // through the ledger; and the overlay derives from the applied
  // stream's completed round — the state the 62b family renders.
  useEffect(() => {
    if (scene === null) return;
    if (!("bodies" in scene.state.measurement)) return;
    const digest = `${String(scene.revision)}|${controls.resolutionId}|${String(controls.signedDistance)}`;
    if (appliedDigestRef.current === digest) return;
    appliedDigestRef.current = digest;
    const tessellation = documentSceneTessellation(
      scene.state.measurement.bodies,
    );
    const field = buildSimFixtureField(tessellation, controls);
    if (!field.ok) {
      setSimError(`${field.error.code}: ${field.error.message}`);
      return;
    }
    const committed = applySimFixtureField(simLedger, field.field);
    if (committed === null) {
      setSimError(
        "sim/field-chunks-invalid: The grid's chunk stream did not apply; the previous overlay stays.",
      );
      return;
    }
    stampSimAppliedCounters(ROOT_ID, committed);
    const applied = simFixtureOverlayOf(field.field);
    const rounds =
      simLedger.fields.get(field.field.block.id)?.roundsCompleted ?? 0;
    setSimError("");
    setSimCounters(committed);
    setOverlay(applied);
    setGridState(
      JSON.stringify({
        fieldId: field.field.block.id,
        semantic: applied.semantic,
        rounds,
        shape: [...applied.field.shape],
        unit: applied.field.unit,
        occupiedNodes: simFixtureOccupiedNodes(field.field.grid),
      }),
    );
  }, [scene, controls, simLedger]);

  /** Saves a scenario record into the document's simulations section. */
  const onSaveScenario = (draft: SimScenarioDraft): void => {
    const added = addDocumentSimulation(workingDocument, draft);
    if (!added.ok) {
      setSimError(`simulation/invalid: ${added.error.message}`);
      return;
    }
    setWorkingDocument(added.value.document);
    setSelectedScenario(added.value.scenario);
    setSimError("");
  };

  /** Boots the sim worker channel on first use (the OCCT boot pattern). */
  const ensureChannel = (): BootedSimWorkerChannel | null => {
    if (channelRef.current !== null) return channelRef.current;
    const booted = bootSimWorkbenchWorker((failure) => {
      setSimError(`sim/worker-crash: ${failure.message}`);
      setRunStatus("failed");
      channelRef.current = null;
    });
    channelRef.current = booted;
    return booted;
  };

  /** Refreshes the persisted run list after a completed run. */
  const refreshRuns = async (store: SimResultStore): Promise<void> => {
    const listed = await store.list(DOCUMENT_VERSION_ID);
    if (listed.ok) setRuns(listed.value);
  };

  /** Runs the selected scenario through the real engine, law S6/S7. */
  const onRunScenario = async (): Promise<void> => {
    const settled = sceneRef.current;
    if (selectedScenario === null) {
      setSimError("Pick or save a scenario before running.");
      return;
    }
    if (settled === null || !("bodies" in settled.state.measurement)) {
      setSimError(
        "The scene has not settled; the tunnel needs its tessellation.",
      );
      return;
    }
    const store = await storeBootRef.current;
    if (store === null) {
      setSimError("sim/store-unavailable: The result store did not boot.");
      return;
    }
    const channel = ensureChannel();
    if (channel === null) return;
    const tessellation = documentSceneTessellation(
      settled.state.measurement.bodies,
    );
    const scenario = serializeSimScenario(selectedScenario);
    setRunStatus("compiling");
    try {
      const outcome: FlowRunOutcome = await runFlowScenario({
        client: channel.client,
        scenario,
        tessellation,
        documentVersionId: DOCUMENT_VERSION_ID,
        store,
        ledger: simLedger,
        events: {
          onPhase: (phase: FlowRunPhase) => setRunStatus(phase),
          onApplied: ({ counters, block }) => {
            stampSimAppliedCounters(ROOT_ID, counters);
            setSimCounters(counters);
            if (block !== null) {
              setLiveOverlay(liveOverlayOf(block));
              setOverlayMode("live");
            }
          },
        },
      });
      setLastResult(outcome.result);
      await refreshRuns(store);
      setRunStatus("completed");
      setSimError("");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setSimError(detail);
      setRunStatus("failed");
    }
  };

  /** Exports the last completed run's decimated .vti field series. */
  const onExportVti = (): void => {
    if (lastResult === null) return;
    const files: readonly SimExportFile[] =
      exportSimResultVtiSeries(lastResult);
    downloadSimExportFiles(files);
    setExportedVti((count) => count + files.length);
  };

  /** Exports the last completed run's force-history CSV. */
  const onExportCsv = (): void => {
    if (lastResult === null) return;
    const csv = exportSimResultForceHistoryCsv(lastResult);
    if (csv === null) return;
    downloadSimExportFiles([
      {
        filename: `${lastResult.summary.scenarioSnapshotHash}-forces.csv`,
        text: csv,
      },
    ]);
    setExportedCsv((count) => count + 1);
  };

  /**
   * Compares two persisted runs (Phase 63d, the risk-S17 boundary: the
   * curve overlay + the field diff, nothing more): fetch both results
   * through the law-S7 store, derive the overlay and the same-field
   * diff, publish the diff's chunk round through the committed-
   * application ledger (law S6 — the counters move on the commit, and
   * the viewport paints only the applied round), and surface every
   * decline verbatim.
   */
  const onCompareRuns = async (): Promise<void> => {
    if (compareRunA === "" || compareRunB === "") {
      setCompareError("Pick two runs to compare.");
      setCompareStatus("failed");
      return;
    }
    if (compareRunA === compareRunB) {
      setCompareError(
        "Pick two DIFFERENT runs — a run against itself is no comparison.",
      );
      setCompareStatus("failed");
      return;
    }
    const store = await storeBootRef.current;
    if (store === null) {
      setCompareError(
        "sim/store-unavailable: The result store did not boot; the comparison cannot read its runs.",
      );
      setCompareStatus("failed");
      return;
    }
    setCompareStatus("comparing");
    const fetchedA = await store.get(compareRunA);
    const fetchedB = await store.get(compareRunB);
    if (!fetchedA.ok) {
      setCompareError(`${fetchedA.error.code}: ${fetchedA.error.message}`);
      setCompareStatus("failed");
      return;
    }
    if (!fetchedB.ok) {
      setCompareError(`${fetchedB.error.code}: ${fetchedB.error.message}`);
      setCompareStatus("failed");
      return;
    }
    if (fetchedA.value === null || fetchedB.value === null) {
      setCompareError(
        "sim/compare-run-not-found: A selected run is no longer in the store.",
      );
      setCompareStatus("failed");
      return;
    }
    const runA = fetchedA.value.result;
    const runB = fetchedB.value.result;
    const curves = simCurveOverlayOf(runA, runB);
    if (!curves.ok) {
      setCompareError(`${curves.error.code}: ${curves.error.message}`);
      setCompareStatus("failed");
      return;
    }
    const diff = simFieldDiffOf(runA, runB, COMPARE_FIELD_ID);
    if (!diff.ok) {
      setCompareError(`${diff.error.code}: ${diff.error.message}`);
      setCompareStatus("failed");
      return;
    }
    const committed = applySimFieldDiff(simLedger, diff.value);
    if (committed === null) {
      setCompareError(
        "sim/field-chunks-invalid: The diff's chunk round did not apply; the previous overlay stays.",
      );
      setCompareStatus("failed");
      return;
    }
    stampSimAppliedCounters(ROOT_ID, committed);
    setSimCounters(committed);
    setCompareCurves(curves.value);
    setCompareDiff(diff.value);
    setCompareOverlay(diffOverlayOf(diff.value));
    setOverlayMode("compare");
    setCompareError("");
    setCompareStatus("ready");
  };

  const lastHash = runs.length > 0 ? runs[runs.length - 1] : undefined;

  return (
    <div
      id={ROOT_ID}
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      data-dispatched="0"
      data-settled="0"
      data-in-flight="0"
      data-current-revision="0"
      data-applied-revision=""
      data-volume=""
      data-cad-rendered-volume=""
      data-sim-applied-notifications=""
      data-sim-applied-field-chunks=""
      data-sim-grid-state={gridState}
      data-sim-grid-error={simError}
      data-sim-scenario-count={String(workingDocument.simulations.length)}
      data-sim-run-status={runStatus}
      data-sim-run-count={String(runs.length)}
      data-sim-run-hash={lastHash?.scenarioSnapshotHash ?? ""}
      data-sim-served-backend={lastResult?.summary.servedBackend ?? ""}
      data-sim-export-vti={String(exportedVti)}
      data-sim-export-csv={String(exportedCsv)}
      data-sim-live-field={liveOverlay === null ? "" : "speed"}
      data-sim-compare-status={compareStatus}
      data-sim-compare-runs={`a:${compareRunA}|b:${compareRunB}`}
      data-sim-compare-diff={compareDiff === null ? "" : compareDiff.fieldId}
      data-sim-compare-l2={
        compareDiff === null ? "" : String(compareDiff.l2Relative)
      }
      data-sim-compare-error={compareError}
      data-rendered-frames={String(renderedFrames)}
      data-error=""
    >
      <div>
        <h1 className="text-lg font-semibold">
          Simulation Workbench Fixture (Phase 62 + 63)
        </h1>
        <p className="text-muted-foreground text-sm">
          The demo body (a cad-jsx model) tessellates through the real Manifold
          worker, voxelizes under an explicit domain, and renders as an
          occupancy grid — and a saved flow scenario runs the real 2D LBM engine
          in the sim worker, streaming live fields through the
          committed-application ledger. Staircase boundaries are the honest
          law-S3 scope until a cut-cell phase exists.
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-64 shrink-0 space-y-4">
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">Resolution</legend>
            {SIM_FIXTURE_RESOLUTIONS.map((preset) => (
              <label
                key={preset.id}
                className="block"
                htmlFor={`sim-resolution-${preset.id}`}
              >
                <input
                  id={`sim-resolution-${preset.id}`}
                  className="mr-1"
                  type="radio"
                  name="sim-resolution"
                  value={preset.id}
                  checked={controls.resolutionId === preset.id}
                  onChange={() => {
                    setControls((previous) => ({
                      ...previous,
                      resolutionId: preset.id,
                    }));
                  }}
                />
                {preset.label}
              </label>
            ))}
          </fieldset>
          <label className="block space-y-1 text-sm" htmlFor="sim-sdf-toggle">
            <span className="font-medium">Field</span>
            <input
              id="sim-sdf-toggle"
              type="checkbox"
              className="mr-1"
              checked={controls.signedDistance}
              onChange={() => {
                setControls((previous) => ({
                  ...previous,
                  signedDistance: !previous.signedDistance,
                }));
              }}
            />
            signed distance (occupancy otherwise)
          </label>
          <ul className="space-y-1 font-mono text-xs">
            <li>
              status = <span id="workbench-sim-status">boot</span>
            </li>
            <li>
              volume = <span id="workbench-sim-volume">…</span>
              {"\u00A0"}mm³
            </li>
            <li>
              bounds = <span id="workbench-sim-bounds">…</span>
              {"\u00A0"}mm
            </li>
            <li>
              triangles = <span id="workbench-sim-triangles">…</span>
            </li>
            <li>
              sim applied ={" "}
              <span id="workbench-sim-applied">
                {simCounters === null
                  ? "…"
                  : `${String(simCounters.notifications)} (${String(simCounters.fieldChunks)} chunks)`}
              </span>
            </li>
            <li>
              grid ={" "}
              <span id="workbench-sim-grid">
                {gridState === "" ? "…" : gridState}
              </span>
            </li>
            <li data-testid="workbench-sim-error" className="text-red-500">
              <span id="workbench-sim-error" />
            </li>
          </ul>
        </div>
        {/* Fixed pixel box: part of the determinism contract (the camera
            spec is authored for this exact viewport; DPR comes from the
            scene's dpr={1}). */}
        <div
          id={VIEWPORT_ID}
          className="h-[520px] w-[800px] shrink-0 overflow-hidden border"
        >
          {scene === null ? (
            <div className="flex h-full items-center justify-center text-sm">
              evaluating…
            </div>
          ) : (
            <CadScene
              projection={scene.state.projection}
              onSettled={() => {
                const root = document.getElementById(ROOT_ID);
                root?.setAttribute(
                  "data-cad-rendered-volume",
                  scene.state.measurement.volume.toFixed(3),
                );
                setRenderedFrames((frames) => frames + 1);
              }}
              regeneration={scene.revision}
            >
              {overlayMode === "compare" && compareOverlay !== null ? (
                <FieldSlicePlane
                  axis="z"
                  colormap={CAD_FIELD_COLORMAP_COOLWARM}
                  field={compareOverlay.field}
                  positionMm={compareOverlay.slicePositionMm}
                  valueRange={compareOverlay.valueRange}
                />
              ) : liveOverlay !== null ? (
                <FieldSlicePlane
                  axis="z"
                  colormap={CAD_FIELD_COLORMAP_VIRIDIS}
                  field={liveOverlay.field}
                  positionMm={liveOverlay.slicePositionMm}
                  valueRange={liveOverlay.valueRange}
                />
              ) : overlay !== null ? (
                <>
                  <FieldSlicePlane
                    axis={overlay.sliceAxis}
                    colormap={overlay.colormap}
                    field={overlay.field}
                    positionMm={overlay.slicePositionMm}
                    valueRange={overlay.valueRange}
                  />
                  <FieldIsoContours
                    axis={overlay.sliceAxis}
                    colormap={overlay.colormap}
                    field={overlay.field}
                    positionMm={overlay.slicePositionMm}
                    thresholds={overlay.thresholds}
                    valueRange={overlay.valueRange}
                  />
                </>
              ) : null}
            </CadScene>
          )}
        </div>
        <div className="w-72 shrink-0 space-y-4">
          <fieldset className="space-y-2 text-sm">
            <legend className="font-medium">Flow scenario (Phase 63)</legend>
            <FlowScenarioForm onSubmitScenario={onSaveScenario} />
            <div className="space-y-1">
              <button
                id="workbench-sim-run"
                type="button"
                className="w-full border px-2 py-1"
                disabled={
                  selectedScenario === null ||
                  ["compiling", "running", "finalizing", "persisting"].includes(
                    runStatus,
                  )
                }
                onClick={() => {
                  void onRunScenario();
                }}
              >
                Run{" "}
                {selectedScenario === null
                  ? "(save a scenario first)"
                  : selectedScenario.name}
              </button>
              <button
                id="workbench-sim-export-vti"
                type="button"
                className="w-full border px-2 py-1"
                disabled={lastResult === null}
                onClick={onExportVti}
              >
                Export .vti field series
              </button>
              <button
                id="workbench-sim-export-csv"
                type="button"
                className="w-full border px-2 py-1"
                disabled={lastResult === null}
                onClick={onExportCsv}
              >
                Export force-history CSV
              </button>
            </div>
          </fieldset>
          <div className="space-y-1 text-sm">
            <p className="font-medium">Runs</p>
            <ul id="workbench-sim-runs" className="space-y-1 font-mono text-xs">
              {runs.length === 0 ? (
                <li>none yet</li>
              ) : (
                runs.map((run) => (
                  <li key={run.id} data-testid="workbench-sim-run-row">
                    {run.id} {run.scenarioSnapshotHash} {run.status}
                  </li>
                ))
              )}
            </ul>
          </div>
          {/* Phase 63d — the run comparison surface: two-run curve
              overlay + field diff ONLY (risk S17's boundary). The run
              selection rides native selects over the persisted run list
              — the fixture-data precedent, not a form. */}
          <fieldset className="space-y-2 text-sm">
            <legend className="font-medium">Compare runs (Phase 63d)</legend>
            <label
              className="block space-y-1"
              htmlFor="workbench-sim-compare-a"
            >
              <span>Run A</span>
              <select
                id="workbench-sim-compare-a"
                className="w-full border px-1 py-0.5 font-mono text-xs"
                value={compareRunA}
                onChange={(event) => {
                  setCompareRunA(event.target.value);
                }}
              >
                <option value="">— pick a run —</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.id} {run.scenarioSnapshotHash}
                  </option>
                ))}
              </select>
            </label>
            <label
              className="block space-y-1"
              htmlFor="workbench-sim-compare-b"
            >
              <span>Run B</span>
              <select
                id="workbench-sim-compare-b"
                className="w-full border px-1 py-0.5 font-mono text-xs"
                value={compareRunB}
                onChange={(event) => {
                  setCompareRunB(event.target.value);
                }}
              >
                <option value="">— pick a run —</option>
                {runs.map((run) => (
                  <option key={run.id} value={run.id}>
                    {run.id} {run.scenarioSnapshotHash}
                  </option>
                ))}
              </select>
            </label>
            <button
              id="workbench-sim-compare"
              type="button"
              className="w-full border px-2 py-1"
              disabled={compareStatus === "comparing"}
              onClick={() => {
                void onCompareRuns();
              }}
            >
              Compare
            </button>
            {compareCurves !== null ? (
              <div
                className="space-y-1"
                data-testid="workbench-sim-compare-curves"
              >
                {compareCurves.quantities.map((quantity) => (
                  <div key={quantity.name} className="space-y-0.5">
                    <p className="font-mono text-[10px]">
                      {quantity.name} ({quantity.unit}) [
                      {quantity.sharedMin.toFixed(3)} …{" "}
                      {quantity.sharedMax.toFixed(3)}]
                    </p>
                    <svg
                      width={COMPARE_PANEL_WIDTH}
                      height={COMPARE_PANEL_HEIGHT}
                      viewBox={`0 0 ${String(COMPARE_PANEL_WIDTH)} ${String(COMPARE_PANEL_HEIGHT)}`}
                      role="img"
                      aria-label={`${quantity.name} overlay of the two compared runs`}
                    >
                      {compareCurves.series
                        .filter((series) => series.quantity === quantity.name)
                        .map((series) => (
                          <polyline
                            key={series.key}
                            data-series={series.key}
                            fill="none"
                            stroke={series.run === "a" ? "#1d4ed8" : "#b91c1c"}
                            strokeWidth={series.run === "a" ? 1.5 : 1}
                            strokeDasharray={
                              series.run === "b" ? "4 2" : undefined
                            }
                            points={simCurvePolylinePoints(
                              series.samples,
                              quantity.sharedMin,
                              quantity.sharedMax,
                              COMPARE_PANEL_WIDTH,
                              COMPARE_PANEL_HEIGHT,
                            )}
                          />
                        ))}
                    </svg>
                  </div>
                ))}
                <p className="font-mono text-[10px]">
                  run A solid blue · run B dashed red · shared window per
                  quantity
                </p>
              </div>
            ) : null}
            {compareDiff !== null ? (
              <p
                className="font-mono text-[10px]"
                data-testid="workbench-sim-compare-diff"
              >
                diff {compareDiff.fieldId} ({compareDiff.unit}): L2{" "}
                {compareDiff.l2Relative.toFixed(4)} · L∞{" "}
                {compareDiff.linfRelative.toFixed(4)} · peak{" "}
                {compareDiff.linfAbs.toFixed(3)} {compareDiff.unit}
              </p>
            ) : null}
            <p
              data-testid="workbench-sim-compare-error"
              className="text-xs text-red-500"
            >
              {compareError}
            </p>
          </fieldset>
        </div>
      </div>
    </div>
  );
}
