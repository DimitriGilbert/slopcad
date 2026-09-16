/**
 * The Phase 11.3 browser fixture, extended in Phase 12 with the selection
 * surface: the real Manifold kernel executing in a real module Web Worker
 * (the Phase 10 worker-fixture wiring, re-hosted) computes the plate, the
 * measurement converts through the public cad-core projection boundary into
 * a {@link RenderProjection} with its deterministic camera spec, and the
 * cad-r3f `CadScene` renders it — grid, world axes, origin marker, fixed
 * light rig, spec camera — under demand-frameloop discipline.
 *
 * ## Selection (Phase 12)
 *
 * Selection state is the cad-core DOMAIN state (`SelectionState`), never
 * renderer state: the fixture owns it, advances it through the documented
 * transitions, and passes it (plus the picking callbacks) to the scene.
 *
 * - **Regeneration identity** is the worker coordinator's applied revision:
 *   every applied computation calls `beginRegeneration`, which drops all
 *   synthetic face references (transience — a parameter change clears
 *   face selections) while stable references persist. Picks are stamped
 *   with the same revision.
 * - **Interaction**: a plain click replaces the selection (single mode);
 *   shift-click toggles (multi mode); the clear button empties the
 *   selection; hovering updates the hover reference. The pick category
 *   control chooses what a click addresses: a synthetic face (default) or
 *   the body. The modifier flag is captured from the viewport's
 *   `pointerdown` so the renderer payload stays a pure domain reference.
 * - **Face-anchor test hook**: for every synthetic face of every rendered
 *   object, the fixture publishes the CSS-pixel position (relative to the
 *   viewport's top-left) of the face's guaranteed-on-face anchor point —
 *   the largest-triangle centroid from cad-core — projected through the
 *   pure spec→screen mapping from cad-r3f, plus the face's mean normal for
 *   semantic identification. Tests click a derived point, never a guessed
 *   pixel; a click at an anchor resolves to that face (unoccluded faces —
 *   asserted by round trip in the spec).
 *
 * ## Machine-readable surface
 *
 * The `#render-root` data attributes and element ids below are the
 * machine-readable surface the Playwright specs read, written at the exact
 * moment their fact becomes true:
 *
 * - `data-volume` — the settled computation's volume;
 * - `data-cad-rendered-volume` — stamped by the scene's `onSettled` on the
 *   first demand frame carrying the current projection's geometry;
 * - `data-selection` — canonical JSON of the selected references;
 * - `data-selection-key` — canonical key of the selection (insertion
 *   order, joined reference keys);
 * - `data-cad-selection-frame` — written by the scene's
 *   `onSelectionRendered` on the first demand frame that CARRIED the
 *   current selection: pixels belong to the highlight only when
 *   `data-cad-selection-frame === data-selection-key`;
 * - `data-hover` — canonical JSON of the hovered reference (or empty);
 * - `data-selection-regeneration` — the regeneration the state stands at;
 * - `data-face-anchors` — the per-face anchor map on `#render-viewport`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  beginRegeneration,
  clearSelection,
  createSelectionState,
  groupSyntheticFaces,
  pickSelection,
  selectionReferenceKey,
  serializeSelectionReference,
  syntheticFaceAnchor,
  syntheticFaceMeanNormal,
  type SelectionReference,
  type SelectionState,
} from "@slopcad/cad-core";
import {
  createStaleResultCoordinator,
  createWebWorkerTransport,
  createWorkerClient,
} from "@slopcad/cad-kernel";
import type { WorkerClient } from "@slopcad/cad-kernel";
import { renderCameraScreenPoint, CadScene } from "@slopcad/cad-r3f";
import type { CadPick, CadPickCategory } from "@slopcad/cad-r3f";
import type { PlateMeasurement } from "../worker-fixture/plate-scene";

import {
  PLATE_HOLE_DIAMETER_DEFAULT_MM,
  PLATE_HOLE_DIAMETER_MAX_MM,
  PLATE_HOLE_DIAMETER_MIN_MM,
} from "../worker-fixture/plate-scene";
import {
  computePlateRenderState,
  type PlateRenderState,
} from "./plate-render-scene";

/** The wired session a booted fixture exposes. */
interface RenderFixtureSession {
  /** Records a parameter change and dispatches its computation. */
  dispatch(holeDiameterMm: number): void;
  /** Settles the channel and terminates the worker. */
  dispose(): void;
}

/** An applied computation: the render state plus its revision identity. */
interface AppliedRenderState {
  readonly state: PlateRenderState;
  readonly revision: number;
}

/**
 * The fixture's fixed viewport, in CSS pixels — the viewport box below is
 * authored at exactly this size (and the scene runs at dpr 1), which is
 * what makes the camera spec's screen mapping constant.
 */
const VIEWPORT_CSS_WIDTH = 800;
const VIEWPORT_CSS_HEIGHT = 520;

function setText(id: string, text: string): void {
  const element = document.getElementById(id);
  if (element !== null) element.textContent = text;
}

/** Bounds rendered as extents, the fixtures' `30.000 × 20.000 × 10.000` form. */
function formatBoundsExtents(measurement: PlateMeasurement): string {
  const { min, max } = measurement.bounds;
  return [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
    .map((extent) => extent.toFixed(3))
    .join(" × ");
}

/** One-decimal rounding for screen points (sub-pixel precision is noise). */
function round1(value: number): number {
  return Number(value.toFixed(1));
}

/** Three-decimal rounding for normal metadata. */
function round3(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * Canonical JSON of a selection reference (fixed key order, so the DOM
 * surface is byte-stable across renders).
 */
function selectionJson(reference: SelectionReference): string {
  return JSON.stringify(serializeSelectionReference(reference));
}

/** Human-readable label of a selection reference for the fixture's list. */
function selectionLabel(reference: SelectionReference): string {
  switch (reference.kind) {
    case "body":
      return `body ${reference.bodyId}`;
    case "solid":
      return `solid ${reference.bodyId}`;
    case "feature":
      return `feature ${reference.featureId}`;
    case "face":
      return `face ${reference.bodyId} #${String(reference.faceIndex)} @rev${String(reference.regeneration)}`;
    case "edge":
      return `edge ${reference.bodyId} #${String(reference.edgeIndex)} @rev${String(reference.regeneration)}`;
    case "vertex":
      return `vertex ${reference.bodyId} #${String(reference.vertexIndex)} @rev${String(reference.regeneration)}`;
  }
}

/**
 * Boots the fixture's worker session (client-only, called from an effect).
 * `onApplied` receives every render state that became the visible one —
 * in application order, newest-wins through the stale-result coordinator —
 * together with the revision identity the domain selection state must
 * stand at.
 */
function bootRenderFixtureSession(
  onApplied: (state: PlateRenderState, revision: number) => void,
): RenderFixtureSession {
  const worker = new Worker(
    new URL("../worker-fixture/manifold-worker-entry.ts", import.meta.url),
    { type: "module" },
  );
  const client: WorkerClient = createWorkerClient({
    transport: createWebWorkerTransport(worker),
  });
  const coordinator = createStaleResultCoordinator<PlateRenderState>({
    client,
  });
  const counters = { dispatched: 0, settled: 0 };
  let errorText = "";

  /** Writes the whole coordinator-driven state surface in one pass. */
  function writeSurface(): void {
    const visible = coordinator.visible();
    const inFlight = counters.dispatched - counters.settled;
    const root = document.getElementById("render-root");
    if (root !== null) {
      root.setAttribute("data-dispatched", String(counters.dispatched));
      root.setAttribute("data-settled", String(counters.settled));
      root.setAttribute("data-in-flight", String(inFlight));
      root.setAttribute(
        "data-current-revision",
        String(coordinator.currentRevision()),
      );
      root.setAttribute(
        "data-applied-revision",
        visible === null ? "" : String(visible.revision),
      );
      root.setAttribute(
        "data-volume",
        visible === null ? "" : visible.state.measurement.volume.toFixed(3),
      );
      root.setAttribute("data-error", errorText);
    }
    setText("render-status", inFlight > 0 ? "computing" : "idle");
    setText(
      "render-volume",
      visible === null ? "…" : visible.state.measurement.volume.toFixed(3),
    );
    setText(
      "render-bounds",
      visible === null ? "…" : formatBoundsExtents(visible.state.measurement),
    );
    setText(
      "render-triangles",
      visible === null ? "…" : String(visible.state.measurement.triangles),
    );
    setText(
      "render-revisions",
      visible === null
        ? `—/${coordinator.currentRevision()}`
        : `${visible.revision}/${coordinator.currentRevision()}`,
    );
    setText("render-error", errorText);
  }

  return {
    dispatch(holeDiameterMm: number): void {
      counters.dispatched += 1;
      writeSurface();
      coordinator
        .update((context) => computePlateRenderState(context, holeDiameterMm))
        .then(
          () => {
            counters.settled += 1;
            writeSurface();
            // The coordinator's visible state is the authority (a superseded
            // computation settles without ever becoming visible).
            const visible = coordinator.visible();
            if (visible !== null) onApplied(visible.state, visible.revision);
          },
          (failure: unknown) => {
            counters.settled += 1;
            errorText =
              failure instanceof Error ? failure.message : String(failure);
            writeSurface();
          },
        );
    },
    dispose(): void {
      client.close();
      worker.terminate();
    },
  };
}

/**
 * The face-anchor map for the applied projection: per rendered object and
 * synthetic face, the CSS-pixel anchor point and the face's mean normal.
 * Pure function of the render state — deterministic, so tests can rely on
 * identical anchors across runs of the same parameters.
 */
function faceAnchorSurface(renderState: PlateRenderState): string {
  const anchors: Record<
    string,
    {
      readonly point: readonly [number, number];
      readonly normal: readonly [number, number, number] | null;
    }
  > = {};
  for (const object of renderState.projection.objects) {
    const grouping = groupSyntheticFaces(object);
    for (const face of grouping.faces) {
      const world = syntheticFaceAnchor(object, grouping, face.index);
      // Closed curved faces (e.g. the bore wall) have no single normal —
      // the cad-core helper reports null and the surface publishes it
      // verbatim instead of a fabricated direction.
      const meanNormal = syntheticFaceMeanNormal(object, grouping, face.index);
      const screen = renderCameraScreenPoint(
        renderState.projection.camera,
        world,
        VIEWPORT_CSS_WIDTH,
        VIEWPORT_CSS_HEIGHT,
      );
      anchors[`${object.bodyId ?? object.id}/${String(face.index)}`] = {
        point: [round1(screen[0]), round1(screen[1])],
        normal:
          meanNormal === null
            ? null
            : [round3(meanNormal[0]), round3(meanNormal[1]), round3(meanNormal[2])],
      };
    }
  }
  return JSON.stringify(anchors);
}

export function RenderFixturePage() {
  const [holeDiameter, setHoleDiameter] = useState(
    PLATE_HOLE_DIAMETER_DEFAULT_MM,
  );
  const [applied, setApplied] = useState<AppliedRenderState | null>(null);
  const [selection, setSelection] = useState<SelectionState>(() =>
    createSelectionState(0),
  );
  const [hover, setHover] = useState<SelectionReference | null>(null);
  const [pickCategory, setPickCategory] = useState<CadPickCategory>("face");
  const additiveRef = useRef(false);
  const sessionRef = useRef<RenderFixtureSession | null>(null);

  useEffect(() => {
    const session = bootRenderFixtureSession((state, revision) => {
      setApplied({ state, revision });
      // The applied revision is a NEW regeneration: synthetic references
      // die with the old one (transience), stable references persist.
      setSelection((previous) => {
        const next = beginRegeneration(previous, revision);
        return next.ok ? next.value : previous;
      });
    });
    sessionRef.current = session;
    session.dispatch(PLATE_HOLE_DIAMETER_DEFAULT_MM);
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
  }, []);

  const faceAnchors = useMemo(
    () => (applied === null ? "" : faceAnchorSurface(applied.state)),
    [applied],
  );

  const handlePick = (pick: CadPick): void => {
    setSelection((previous) => {
      const next = pickSelection(previous, pick.reference, {
        additive: additiveRef.current,
      });
      return next.ok ? next.value : previous;
    });
  };

  return (
    <div
      id="render-root"
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      data-dispatched="0"
      data-settled="0"
      data-in-flight="0"
      data-current-revision="0"
      data-applied-revision=""
      data-volume=""
      data-cad-rendered-volume=""
      data-selection={JSON.stringify(
        selection.selected.map(serializeSelectionReference),
      )}
      data-selection-key={selection.selected
        .map(selectionReferenceKey)
        .join(";")}
      data-cad-selection-frame=""
      data-hover={hover === null ? "" : selectionJson(hover)}
      data-selection-regeneration={String(selection.regeneration)}
      data-error=""
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 12 Selection Fixture (deterministic scene)
        </h1>
        <p className="text-muted-foreground text-sm">
          Real Manifold worker → plate → render projection (camera spec
          included) → deterministic CAD scene: grid, axes, origin, fixed light
          rig, demand frameloop. Click selects (shift-click toggles); picks
          resolve to domain references.
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-64 shrink-0 space-y-4">
          <label className="block text-sm" htmlFor="param-holeDiameter">
            <span className="mb-1 block font-medium">
              holeDiameter (mm), {PLATE_HOLE_DIAMETER_MIN_MM}–
              {PLATE_HOLE_DIAMETER_MAX_MM}
            </span>
            <input
              id="param-holeDiameter"
              className="border-input bg-background w-full rounded border px-2 py-1 font-mono"
              type="number"
              min={PLATE_HOLE_DIAMETER_MIN_MM}
              max={PLATE_HOLE_DIAMETER_MAX_MM}
              step={0.5}
              disabled={applied === null}
              value={holeDiameter}
              onChange={(event) => {
                const parsed = Number(event.target.value);
                if (
                  Number.isFinite(parsed) &&
                  parsed >= PLATE_HOLE_DIAMETER_MIN_MM &&
                  parsed <= PLATE_HOLE_DIAMETER_MAX_MM
                ) {
                  setHoleDiameter(parsed);
                  sessionRef.current?.dispatch(parsed);
                }
              }}
            />
          </label>
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">Pick category</legend>
            <label className="block" htmlFor="pick-category-face">
              <input
                id="pick-category-face"
                className="mr-1"
                type="radio"
                name="pick-category"
                value="face"
                checked={pickCategory === "face"}
                onChange={() => {
                  setPickCategory("face");
                }}
              />
              face (synthetic)
            </label>
            <label className="block" htmlFor="pick-category-body">
              <input
                id="pick-category-body"
                className="mr-1"
                type="radio"
                name="pick-category"
                value="body"
                checked={pickCategory === "body"}
                onChange={() => {
                  setPickCategory("body");
                }}
              />
              body (stable)
            </label>
          </fieldset>
          <div>
            <button
              id="selection-clear"
              className="border-input bg-background rounded border px-2 py-1 text-sm"
              type="button"
              onClick={() => {
                setSelection(clearSelection);
              }}
            >
              Clear selection
            </button>
          </div>
          <ul className="space-y-1 font-mono text-xs">
            <li>
              status = <span id="render-status">boot</span>
            </li>
            <li>
              volume = <span id="render-volume">…</span>
              {"\u00A0"}mm³
            </li>
            <li>
              bounds = <span id="render-bounds">…</span>
              {"\u00A0"}mm
            </li>
            <li>
              triangles = <span id="render-triangles">…</span>
            </li>
            <li>
              revisions (applied/current) = <span id="render-revisions">…</span>
            </li>
            <li>
              selection rev ={" "}
              <span id="selection-regeneration">
                {String(selection.regeneration)}
              </span>
            </li>
            <li data-testid="render-error" className="text-red-500">
              <span id="render-error" />
            </li>
          </ul>
          <div className="text-sm">
            <span className="font-medium">Selection</span>
            <ul id="selection-list" className="font-mono text-xs">
              {selection.selected.map((reference) => (
                <li key={selectionReferenceKey(reference)}>
                  {selectionLabel(reference)}
                </li>
              ))}
            </ul>
          </div>
        </div>
        {/* Fixed pixel box: part of the determinism contract (the camera
            spec is authored for this exact viewport; DPR comes from the
            scene's dpr={1}). The pointerdown listener captures the shift
            modifier so pick payloads stay pure domain references. */}
        <div
          id="render-viewport"
          className="h-[520px] w-[800px] shrink-0 overflow-hidden border"
          data-face-anchors={faceAnchors}
          onPointerDown={(event) => {
            additiveRef.current = event.shiftKey;
          }}
        >
          {applied === null ? (
            <div className="flex h-full items-center justify-center text-sm">
              evaluating…
            </div>
          ) : (
            <CadScene
              projection={applied.state.projection}
              onSettled={() => {
                document
                  .getElementById("render-root")
                  ?.setAttribute(
                    "data-cad-rendered-volume",
                    applied.state.measurement.volume.toFixed(3),
                  );
              }}
              regeneration={applied.revision}
              selection={selection.selected}
              pickCategory={pickCategory}
              onPick={handlePick}
              onHover={(pick) => {
                setHover(pick === null ? null : pick.reference);
              }}
              onSelectionRendered={(selectionKey) => {
                document
                  .getElementById("render-root")
                  ?.setAttribute("data-cad-selection-frame", selectionKey);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
