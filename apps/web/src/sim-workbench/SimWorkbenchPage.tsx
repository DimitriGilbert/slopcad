/**
 * The `/workbench-sim` fixture page (ROADMAP-SIM Phase 62c) — Phase 62's
 * user-visible outcome: "here is your part as a grid."
 *
 * ## Pipeline
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
 * `CadScene` children slot — the colormap slice at the grid's own
 * mid-height node plane, with the 0.5 iso-contour tracing the honest
 * voxel staircase.
 *
 * ## Committed applications (law S6)
 *
 * Each grid publishes as a chunk stream and applies through the Phase
 * 61d ledger (`sim-application-ledger`): the counters advance ONLY on
 * chunks that actually applied, stamped synchronously as the
 * `data-sim-*` attribute family on the settle root — the same
 * attributes the workbench engine stamps, awaited by e2e instead of
 * timeouts. The overlay mounts from the applied stream's completed
 * round, so overlay application IS committed application. No rAF, no
 * frame loop: `frameloop="demand"` stays law and the overlays
 * invalidate on their own data changes.
 *
 * ## Machine-readable surface
 *
 * The render session's settle family (`data-dispatched`,
 * `data-settled`, `data-in-flight`, `data-current-revision`,
 * `data-applied-revision`, `data-volume`, `data-cad-rendered-volume`,
 * `data-error`) plus the sim family (`data-sim-applied-notifications`,
 * `data-sim-applied-field-chunks`, `data-sim-applied-progress-step`)
 * and the applied-grid state (`data-sim-grid-state`, canonical JSON of
 * the committed overlay's semantic, field id, rounds, shape, unit, and
 * occupied node count; `data-sim-grid-error` carries a voxelizer
 * refusal verbatim).
 */

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CadScene, FieldIsoContours, FieldSlicePlane } from "@slopcad/cad-r3f";

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

/** The settle root every attribute family lands on. */
const ROOT_ID = "workbench-sim-root";
/** The fixed-pixel viewport (the determinism contract's authored frame). */
const VIEWPORT_ID = "workbench-sim-viewport";

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
        setScene({ state, revision });
      },
    );
    session.dispatchDocument(DEMO_BODIES, DEMO_RENDERABLE);
    return () => {
      session.dispose();
    };
  }, []);

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
      data-rendered-frames={String(renderedFrames)}
      data-error=""
    >
      <div>
        <h1 className="text-lg font-semibold">
          Simulation Workbench Fixture (Phase 62)
        </h1>
        <p className="text-muted-foreground text-sm">
          The demo body (a cad-jsx model) tessellates through the real Manifold
          worker, voxelizes under an explicit domain, and renders as an
          occupancy grid — the colormap slice and the 0.5 iso-contour at the
          grid&apos;s mid-height node plane. Staircase boundaries are the honest
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
              {overlay !== null ? (
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
      </div>
    </div>
  );
}
