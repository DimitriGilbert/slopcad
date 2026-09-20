/**
 * The composed CAD workbench (Phase 15 phase-level deliverable, extended in
 * Phase 20; Phase 28 refactor): ONE browser page that mounts all four
 * `@slopcad/ui` CAD components — CadToolbar, CadViewport, CadModelTree,
 * CadParameterPanel — around a real document through a single `CadProvider`
 * store, in a product-grade tool layout: one dense command row across the
 * top — the tool strip, the feature timeline behind a divider, and the
 * undo/redo pair — with the model tree docked left, the parameter panel
 * docked right (internally scrollable when the document outgrows the
 * frame), the viewport dominant between them, and a status bar along the
 * bottom.
 *
 * Phase 28 moved the page's ORCHESTRATION (the store, the threaded
 * regeneration loop, the session boot, the scene dispatch, the create
 * actions, and the inspection readouts) verbatim into the shared workbench
 * engine (`./workbench-engine`) that the Phase 28 complete workbench
 * composition also runs on; this file is now the page's LAYOUT — the exact
 * DOM the Phase 15–27 render baselines pin (ids, attributes, structure),
 * rendered from the engine's returns.
 *
 * ## Composition wiring (page level only)
 *
 * The store is composed ONCE from the workbench's domain instances and
 * handed to `CadProvider`. Every component mirrors its own concern below
 * that provider, so the components work TOGETHER while staying
 * independent; the page-level effects follow the document (the worker
 * computation follows the hole parameter), push the current projection
 * into the store, and announce each applied revision as a new
 * regeneration — all inside the engine.
 *
 * ## The feature timeline strip
 *
 * The timeline is the history surface no component owns (the same reason
 * the undo/redo pair lives here, and the reason both share the command
 * row): one chip per feature in document order, joined five-way status per
 * chip, the rollback marker as a clickable element BETWEEN chips, and a
 * suppress toggle per chip.
 *
 * ## Machine-readable surface (`#workbench-root`)
 *
 * The settle attributes the worker session writes (`data-in-flight`,
 * `data-applied-revision`, `data-current-revision`, `data-volume`,
 * `data-error`), the viewport's settle stamps (`data-cad-rendered-volume`
 * from `onSettled`, `data-cad-selection-frame` from `onSelectionRendered`),
 * the mirrored domain state (`data-selection`, `data-selection-key`,
 * `data-tool-id`, `data-tool-phase`, `data-tool-state`,
 * `data-tool-completion`, `data-tool-failure`, `data-measure` (the
 * measure tool's point-pair completion), `data-distance`,
 * `data-distance-source` and `data-distance-declined` (the Phase 27.2
 * reference-matrix readout and its structured decline), `data-bounds` and
 * `data-bounds-tightness` (the Phase 27.1 bounds inspection's readout and
 * the booted kernel's declared tightness), `data-radius`,
 * `data-radius-diameter`, `data-radius-source` and `data-radius-declined`
 * (the Phase 27.3 radius inspection's dual presentation and its structured
 * decline),
 * `data-command-log` (the store's canonical serialized transactions),
 * `data-hole-diameter` (the document's stored parameter), `data-history`
 * (the undo/redo view), `data-feature-timeline` (the Phase 20 view: rollback
 * marker, per-feature joined statuses, the last run's executed sequence),
 * and `data-rendered-frames`, plus `data-face-anchors` on
 * `#workbench-viewport` (the deterministic click targets, relative to the
 * viewport's 800×520 CSS box — the size the fixture camera spec is authored
 * for).
 */

import { useEffect, useMemo } from "react";
import type { ReactElement } from "react";
import {
  serializeSelectionReference,
  selectionReferenceKey,
} from "@slopcad/cad-react";
import { formatBoundsExtents } from "@slopcad/cad-core";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
import { CadModelTree } from "@slopcad/ui/components/cad/cad-model-tree";
import { CadParameterPanel } from "@slopcad/ui/components/cad/cad-parameter-panel";
import { CadToolbar } from "@slopcad/ui/components/cad/cad-toolbar";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";

import { completionJson } from "../render-fixture/fixture-session";
import { SketchMode } from "./SketchMode";
import { FeatureTimelineStrip } from "./feature-timeline-strip";
import { WorkbenchMeasurementSection } from "./measurement-section";
import { honestSceneFallback } from "./scene-fallback";
import {
  useWorkbenchEngine,
  WorkbenchStoreProvider,
  type WorkbenchEngine,
} from "./workbench-engine";

export function CadWorkbenchPage(): ReactElement {
  // The store is composed ONCE (the engine factory) and handed to the
  // provider; the body below renders the layout from the engine.
  return (
    <WorkbenchStoreProvider>
      <CadWorkbenchBody />
    </WorkbenchStoreProvider>
  );
}

function CadWorkbenchBody(): ReactElement {
  const engine = useWorkbenchEngine({
    rootId: "workbench-root",
    statusId: "workbench-status",
    volumeId: "workbench-volume",
    errorId: "workbench-error",
  });
  return <WorkbenchLayout engine={engine} />;
}

/**
 * The composed workbench's LAYOUT, rendered from a caller-supplied engine
 * run: the exact Phase 15-27 DOM (ids, attributes, structure), now shared
 * by every page that boots the engine. The optional `bar` slot renders one
 * page-level row ABOVE the command row (Phase 31: the persistence bar of
 * the project-scoped workbench); when absent — the bare workbench — the
 * DOM is byte-identical to the pinned baseline.
 */
export function WorkbenchLayout({
  engine,
  bar,
}: {
  readonly engine: WorkbenchEngine;
  readonly bar?: ReactElement;
}): ReactElement {
  const {
    applied,
    historyApi,
    holeBase,
    mode,
    noteRenderedFrame,
    regenerationIssue,
    regenerationStates,
    rollback,
    selectionApi,
    setMode,
    setRollback,
    storedHole,
    timeline,
    timelineJson,
    toolsApi,
    toggleSuppressed,
    handleExtrude,
    handleHole,
    handleRevolve,
  } = engine;
  const store = engine.store;
  const appliedState = applied;
  const faceAnchors = engine.faceAnchors;
  const measureText = engine.measureText;
  const boundsState = engine.boundsState;
  const radiusState = engine.radiusState;
  const massPropertiesState = engine.massPropertiesState;

  // The honest scene fallback (the engine's own documented contract, shared
  // by every page that renders this layout): an authoring move that REMOVES
  // document data — an undo that reverts the anchored solid feature, a
  // reopened older version — can invalidate the active scene's request, and
  // the engine's dispatch then silently no-ops while the viewport keeps the
  // removed solid's stale pixels and `data-scene-kind`. When the active
  // scene stops resolving over the live document, re-point the dispatch at
  // the highest scene the document still resolves (hole over revolve over
  // extrude, then the plate) — the same fallback the complete workbench
  // implements. The effect only ever FALLS BACK: a newly created deeper
  // scene wins through its action's own scene switch, never through this.
  const activeScene = engine.activeScene;
  const workbenchDocument = engine.documentApi.document;
  useEffect(() => {
    const fallback = honestSceneFallback(workbenchDocument, activeScene);
    if (fallback !== null) {
      engine.setActiveScene(fallback);
    }
  }, [activeScene, engine, workbenchDocument]);

  const selectionKey = useMemo(
    () => selectionApi.selected.map(selectionReferenceKey).join(";"),
    [selectionApi.selected],
  );

  // The distance row's value priority: the reference pair when one is
  // selected; otherwise the measure tool's quick point-pair completion (the
  // Phase 13 gesture keeps its role); otherwise nothing.
  const referenceDistance = engine.referenceDistance;
  const distanceText =
    referenceDistance.text ??
    (measureText === null ? null : `${measureText} mm`);
  const distanceSource =
    referenceDistance.text !== null
      ? referenceDistance.source
      : measureText !== null
        ? "point pair"
        : null;

  return (
    <div
      id="workbench-root"
      className="flex h-full min-h-0 flex-col"
      data-selection={JSON.stringify(
        selectionApi.selected.map(serializeSelectionReference),
      )}
      data-selection-key={selectionKey}
      data-selection-regeneration={String(selectionApi.regeneration)}
      data-tool-id={toolsApi.activeToolId ?? ""}
      data-tool-phase={toolsApi.phase}
      data-tool-state={JSON.stringify(toolsApi.toolState)}
      data-tool-completion={
        toolsApi.completion === null ? "" : completionJson(toolsApi.completion)
      }
      data-tool-failure={
        toolsApi.failure === null ? "" : JSON.stringify(toolsApi.failure)
      }
      data-measure={measureText === null ? "" : `${measureText} mm`}
      data-distance={distanceText ?? ""}
      data-distance-source={distanceSource ?? ""}
      data-distance-declined={referenceDistance.declined ?? ""}
      data-radius={radiusState.text ?? ""}
      data-radius-diameter={radiusState.diameterText ?? ""}
      data-radius-source={radiusState.source ?? ""}
      data-radius-declined={radiusState.declined ?? ""}
      data-bounds={boundsState.text ?? ""}
      data-bounds-tightness={boundsState.tightness}
      data-mass-volume={massPropertiesState.volumeText ?? ""}
      data-mass-area={massPropertiesState.areaText ?? ""}
      data-command-log={JSON.stringify(store.commandLog)}
      data-rendered-frames={String(engine.renderedFrames)}
      data-hole-diameter={storedHole === null ? "" : String(storedHole)}
      data-history={JSON.stringify({
        canUndo: historyApi.canUndo,
        canRedo: historyApi.canRedo,
        cursor: historyApi.cursor,
        depth: historyApi.depth,
      })}
      data-feature-timeline={timelineJson}
      data-sketch-mode={mode}
      data-scene-kind={engine.activeScene}
      data-scene-extents={
        appliedState === null
          ? ""
          : formatBoundsExtents(appliedState.state.measurement.bounds)
      }
      data-scene-bounds={
        appliedState === null
          ? ""
          : JSON.stringify({
              min: appliedState.state.measurement.bounds.min.map((v) =>
                Number(v.toFixed(3)),
              ),
              max: appliedState.state.measurement.bounds.max.map((v) =>
                Number(v.toFixed(3)),
              ),
            })
      }
    >
      {/* The page-level bar (Phase 31 persistence chrome) when the host
          supplies one; the bare workbench renders nothing here, keeping its
          pinned DOM byte-identical. */}
      {bar === undefined ? null : (
        <div className="border-border bg-background shrink-0 border-b">
          {bar}
        </div>
      )}
      {/* Tool row: the component's tool strip; the feature timeline (the
          Phase 20 history surface) sits beside it behind a divider, and the
          undo/redo pair on the right — the page-level surfaces of concerns
          no component owns. One dense row keeps the docked palettes inside
          the workbench frame at the fixture's fixed viewport. In sketch
          mode the row (and the whole model workspace) yields to the sketch
          editor, which carries its own command row; the model surfaces stay
          MOUNTED but hidden so the worker session's surface writer keeps
          their ids. */}
      <div
        className={`border-border bg-background h-10 shrink-0 items-center gap-2 border-b px-2 ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        {/* Provider-driven toolbar: no props — it mirrors the registry,
            presses the live tool, and arms through the store's arm op. The
            row it sits in carries the divider, so the strip drops its own
            box. */}
        <CadToolbar className="border-0 bg-transparent p-0" />
        <div
          aria-label="Feature timeline"
          className="border-border flex h-full min-w-0 items-center gap-1 border-l pl-3"
          data-testid="feature-timeline"
          role="group"
        >
          <span className="text-muted-foreground mr-1 text-xs font-medium tracking-wider uppercase">
            Timeline
          </span>
          {timeline === null ? (
            <span className="text-muted-foreground text-xs">
              {regenerationIssue ?? "\u2026"}
            </span>
          ) : (
            <FeatureTimelineStrip
              entries={timeline}
              rollback={rollback}
              onRollback={setRollback}
              onToggleSuppressed={toggleSuppressed}
            />
          )}
        </div>
        <div className="flex-1" />
        <div
          aria-label="History"
          className="flex items-center gap-1"
          role="group"
        >
          <Button
            id="history-undo"
            type="button"
            variant="ghost"
            size="xs"
            disabled={!historyApi.canUndo}
            onClick={() => {
              historyApi.undo();
            }}
          >
            <Undo2 data-icon="inline-start" />
            Undo
          </Button>
          <Button
            id="history-redo"
            type="button"
            variant="ghost"
            size="xs"
            disabled={!historyApi.canRedo}
            onClick={() => {
              historyApi.redo();
            }}
          >
            <Redo2 data-icon="inline-start" />
            Redo
          </Button>
        </div>
        {/* The Phase 26.10 hole action: cuts the document's last extrusion
            with parameter-panel-driven defaults (the hole feature's five
            parameters land in the right dock, each a parameter.set away
            from a regeneration). Needs a solid first — the button states
            that instead of pretending. */}
        <Button
          data-testid="workbench-hole"
          title={
            holeBase === undefined
              ? "Sketch and extrude a profile first — a hole cuts an existing solid."
              : "Cut a hole into the latest extrusion (defaults on the top face's center; edit holeDiameter/holeDepth/holeX/holeY in the parameter panel)."
          }
          disabled={holeBase === undefined}
          onClick={() => {
            handleHole();
          }}
          size="xs"
          type="button"
          variant="outline"
        >
          Hole
        </Button>
        <Button
          data-testid="workbench-mode-toggle"
          onClick={() => {
            setMode("sketch");
          }}
          size="xs"
          type="button"
          variant="outline"
        >
          Sketch
        </Button>
      </div>
      {mode === "sketch" ? (
        <SketchMode
          onExit={() => {
            setMode("model");
          }}
          onExtrude={handleExtrude}
          onRevolve={handleRevolve}
        />
      ) : null}
      {/* The workspace: tree palette left, viewport dominant, parameter
          palette right — the components' own sizes are the layout's sizes.
          The row is centered as a group so the leftover workspace frames
          the composition symmetrically instead of pooling below it. Hidden
          (not unmounted) in sketch mode: the model keeps living. */}
      <div
        className={`min-h-0 flex-1 items-center justify-center p-3 ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        <div className="flex max-h-full min-h-0 items-start gap-3">
          <div className="flex w-48 shrink-0 flex-col gap-3">
            {/* Provider-driven tree with one explicit prop: the regeneration
                states. Document, selection, and picks all mirror the store. */}
            {regenerationStates === null ? null : (
              <CadModelTree
                regenerationStates={regenerationStates}
                className="w-48"
              />
            )}
            {/* The measurement home (the Phase 13 block, extended in Phases
                27.1–27.4): the ONE shared section (see
                ./measurement-section) — the complete workbench renders the
                same block from the same engine readouts. */}
            <WorkbenchMeasurementSection
              boundsState={boundsState}
              distanceSource={distanceSource}
              distanceText={distanceText}
              massPropertiesState={massPropertiesState}
              radiusState={radiusState}
            />
          </div>
          {/* Fixed pixel box: part of the determinism contract (the camera
              spec is authored for exactly this 800×520 viewport; the scene
              runs at dpr 1). Provider-driven viewport: no selection props,
              no pick callbacks — picks, hovers, and keyboard are the
              component's own wiring. No overlay: the status bar carries the
              state the fixture chips used to. */}
          <div
            id="workbench-viewport"
            className="shrink-0"
            data-face-anchors={faceAnchors}
          >
            <CadViewport
              className="h-[520px] w-[800px]"
              projection={
                appliedState === null ? null : appliedState.state.projection
              }
              onSettled={() => {
                // Settle protocol, exactly the Phase 15 semantics the
                // render baselines pin: pixels may be compared only once
                // this stamp agrees with the settled volume, written
                // SYNCHRONOUSLY in the settle callback.
                noteRenderedFrame(
                  appliedState === null
                    ? ""
                    : appliedState.state.measurement.volume.toFixed(3),
                );
              }}
              onSelectionRendered={(key) => {
                document
                  .getElementById("workbench-root")
                  ?.setAttribute("data-cad-selection-frame", key);
              }}
            />
          </div>
          {/* Provider-driven parameter panel: no props — it mirrors the
              document's parameters, validates expressions with the domain's
              own parser/evaluator, and applies edits as parameter.set
              transactions through the store. */}
          {/* The parameter dock scrolls internally when the document
              carries more parameters than the frame shows at once — a
              docked palette never pushes the status bar around. */}
          <div className="flex min-h-0 flex-1 flex-col self-stretch overflow-y-auto">
            <CadParameterPanel className="w-60 shrink-0" />
          </div>
        </div>
      </div>
      {/* Status bar: the settled numbers the operator works against. The
          status and volume spans are written by the worker session's
          surface writer (the fixture pattern); the rest mirror the store.
          Hidden in sketch mode — the sketch editor carries its own status
          line — but MOUNTED, so the writer's ids keep existing. */}
      <div
        className={`border-border bg-background text-muted-foreground h-7 shrink-0 items-center gap-4 border-t px-3 font-mono text-xs ${
          mode === "sketch" ? "hidden" : "flex"
        }`}
      >
        <span>
          status ={" "}
          <span id="workbench-status" data-testid="workbench-status">
            boot
          </span>
        </span>
        <span>
          volume = <span id="workbench-volume">…</span>
          {"\u00A0"}mm³
        </span>
        <span>
          tool = {toolsApi.activeToolId ?? "none"} ({toolsApi.phase})
        </span>
        <span>selection = {selectionApi.selected.length}</span>
        <span>commands = {store.commandLog.length}</span>
        <span data-testid="workbench-error" className="text-destructive">
          <span id="workbench-error" />
        </span>
      </div>
    </div>
  );
}
