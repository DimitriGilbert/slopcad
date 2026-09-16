/**
 * The composed CAD workbench (Phase 15 phase-level deliverable): ONE browser
 * page that mounts all four `@slopcad/ui` CAD components — CadToolbar,
 * CadViewport, CadModelTree, CadParameterPanel — around a real document
 * through a single `CadProvider` store, in a product-grade tool layout: the
 * tool strip across the top, the model tree docked left, the parameter panel
 * docked right, the viewport dominant between them, and a status bar along
 * the bottom. This page REPLACES the Phase 14 hand-rolled workbench fixture:
 * every control that overlapped a component (the raw parameter input, the
 * hand-wired tool buttons, the selection list, the bare `CadScene`) is now
 * the component's own provider-driven surface, and nothing overlaps remains.
 *
 * ## Composition wiring (page level only)
 *
 * The store is composed ONCE from the workbench's domain instances (the
 * lean workbench document — plate, bore diameter, rotate feature,
 * expression-driven `volumeHint` — and the tools that document supports:
 * select, measure, rotate) and handed to `CadProvider`. Every
 * component mirrors its own concern below that provider — the toolbar arms
 * tools through the store, viewport picks flow to the armed tool (or, with
 * none armed, to the selection), the tree applies picks and mirrors
 * selection, and the panel commits `parameter.set` transactions — so the
 * components work TOGETHER while staying independent: no component reaches
 * into another's internals; the only wiring is the shared store plus the
 * page-level effects every fixture shares (boot the worker session, follow
 * the document's hole parameter, push the current projection into the
 * store, and announce each applied revision as a new regeneration).
 *
 * The page itself adds only what no component owns and the workbench needs:
 * the undo/redo pair (the history concern has no component), the
 * measurement readout (the measure tool's completion needs a home), and the
 * status bar (the settled numbers the operator works against). The tree
 * receives exactly ONE prop — the regeneration state map — because statuses
 * are PROP-ONLY; it is derived from the document through the domain's own
 * `regenerate` orchestration with the shared executor stand-in.
 *
 * ## Machine-readable surface (`#workbench-root`)
 *
 * The settle attributes the worker session writes (`data-in-flight`,
 * `data-applied-revision`, `data-current-revision`, `data-volume`,
 * `data-error`), the viewport's settle stamps (`data-cad-rendered-volume`
 * from `onSettled`, `data-cad-selection-frame` from `onSelectionRendered`),
 * the mirrored domain state (`data-selection`, `data-selection-key`,
 * `data-tool-id`, `data-tool-phase`, `data-tool-state`,
 * `data-tool-completion`, `data-tool-failure`, `data-measure`),
 * `data-command-log` (the store's canonical serialized transactions),
 * `data-hole-diameter` (the document's stored parameter), `data-history`
 * (the history view), and `data-rendered-frames`, plus
 * `data-face-anchors` on `#workbench-viewport` (the deterministic click
 * targets, relative to the viewport's 800×520 CSS box — the size the
 * fixture camera spec is authored for).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  CadProvider,
  createCadStore,
  measureTool,
  registerTool,
  rotateTool,
  selectTool,
  SELECT_TOOL_ID,
  selectionReferenceKey,
  serializeSelectionReference,
  useCadDocument,
  useCadHistory,
  useCadSelection,
  useCadStore,
  useCadTools,
  valueIn,
} from "@slopcad/cad-react";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@slopcad/ui/components/button";
import { CadModelTree } from "@slopcad/ui/components/cad/cad-model-tree";
import { CadParameterPanel } from "@slopcad/ui/components/cad/cad-parameter-panel";
import { CadToolbar } from "@slopcad/ui/components/cad/cad-toolbar";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import {
  bootRenderFixtureSession,
  completionJson,
  faceAnchorSurface,
  type RenderFixtureSession,
} from "../render-fixture/fixture-session";
import { holeDiameterMm } from "../workbench-fixture/workbench-document";
import { deriveWorkbenchRegenerationStates } from "../workbench-fixture/workbench-extended-document";
import { createCadWorkbenchSession } from "./session";

/** An applied computation: the render state plus its revision identity. */
interface AppliedRenderState {
  readonly state: PlateRenderState;
  readonly revision: number;
}

export function CadWorkbenchPage(): ReactElement {
  // The store is composed ONCE from the workbench's domain instances; the
  // provider hands it to the hooks and to every CAD component below. The
  // session is the workbench's lean document (see session.ts): plate, bore
  // diameter, rotate feature, expression-driven volumeHint.
  const [store] = useState(() =>
    createCadStore({
      session: createCadWorkbenchSession(),
      tools: [
        registerTool(selectTool),
        registerTool(measureTool),
        registerTool(rotateTool),
      ],
    }),
  );

  return (
    <CadProvider store={store}>
      <CadWorkbenchBody />
    </CadProvider>
  );
}

function CadWorkbenchBody(): ReactElement {
  const store = useCadStore("CadWorkbenchPage");
  const documentApi = useCadDocument();
  const selectionApi = useCadSelection();
  const toolsApi = useCadTools();
  const historyApi = useCadHistory();
  const { arm } = toolsApi;
  const { beginRegeneration } = selectionApi;

  const [applied, setApplied] = useState<AppliedRenderState | null>(null);
  const [renderedFrames, setRenderedFrames] = useState(0);
  const sessionRef = useRef<RenderFixtureSession | null>(null);

  // The executor stand-in: the document's hole parameter is the source of
  // truth; the worker computation follows it (the same pipeline as the
  // /render and Phase 14 fixtures).
  const storedHole = holeDiameterMm(documentApi.document);

  // The tree's statuses: derived from the CURRENT document through the
  // domain's regenerate orchestration (statuses are PROP-ONLY).
  const regenerationStates = useMemo(
    () => deriveWorkbenchRegenerationStates(documentApi.document),
    [documentApi.document],
  );

  useEffect(() => {
    // The host's explicit boot configuration: the SELECT tool armed through
    // the hook layer (cancel-if-active, reset, activate).
    arm(SELECT_TOOL_ID);
    const session = bootRenderFixtureSession(
      {
        rootId: "workbench-root",
        statusId: "workbench-status",
        volumeId: "workbench-volume",
        errorId: "workbench-error",
      },
      (state, revision) => {
        setApplied({ state, revision });
        // A NEW regeneration: synthetic references die with the old one;
        // stable references persist.
        beginRegeneration(revision);
      },
    );
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
    // arm and beginRegeneration are stable store operation identities: the
    // session boots exactly once.
  }, [arm, beginRegeneration]);

  useEffect(() => {
    if (storedHole === null) return;
    sessionRef.current?.dispatch(storedHole);
  }, [storedHole]);

  // The host pushes the CURRENT projection into the store — the projection
  // access the active tool reads. Host-side state push, not mirrored state.
  useEffect(() => {
    store.setProjection(applied === null ? null : applied.state.projection);
  }, [applied, store]);

  const selectionKey = useMemo(
    () => selectionApi.selected.map(selectionReferenceKey).join(";"),
    [selectionApi.selected],
  );

  const faceAnchors = useMemo(
    () => (applied === null ? "" : faceAnchorSurface(applied.state)),
    [applied],
  );

  // The measure tool's completion: the readout the Measurement block shows.
  const measureText =
    toolsApi.completion !== null &&
    toolsApi.completion.detail.kind === "measurement"
      ? valueIn(toolsApi.completion.detail.distance, "mm").toFixed(3)
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
      data-command-log={JSON.stringify(store.commandLog)}
      data-rendered-frames={String(renderedFrames)}
      data-hole-diameter={storedHole === null ? "" : String(storedHole)}
      data-history={JSON.stringify({
        canUndo: historyApi.canUndo,
        canRedo: historyApi.canRedo,
        cursor: historyApi.cursor,
        depth: historyApi.depth,
      })}
    >
      {/* Tool row: the component's tool strip; the history pair is the
          page-level surface of a concern no component owns. */}
      <div className="border-border bg-background flex h-10 shrink-0 items-center gap-3 border-b px-2">
        {/* Provider-driven toolbar: no props — it mirrors the registry,
            presses the live tool, and arms through the store's arm op. The
            row it sits in carries the divider, so the strip drops its own
            box. */}
        <CadToolbar className="border-0 bg-transparent p-0" />
        <div className="flex-1" />
        <div aria-label="History" className="flex items-center gap-1" role="group">
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
      </div>
      {/* The workspace: tree palette left, viewport dominant, parameter
          palette right — the components' own sizes are the layout's sizes.
          The row is centered as a group so the leftover workspace frames
          the composition symmetrically instead of pooling below it. */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-3">
        <div className="flex items-start gap-3">
          <div className="flex w-48 shrink-0 flex-col gap-3">
            {/* Provider-driven tree with one explicit prop: the regeneration
                states. Document, selection, and picks all mirror the store. */}
            <CadModelTree
              regenerationStates={regenerationStates}
              className="w-48"
            />
            <section
              aria-label="Measurement"
              className="border-border bg-background w-48 border"
            >
              <div className="text-muted-foreground border-border border-b px-2 py-1.5 text-xs font-medium tracking-wider uppercase">
                Measurement
              </div>
              <div className="px-2 py-2 text-sm">
                {measureText === null ? (
                  <span className="text-muted-foreground font-mono">—</span>
                ) : (
                  <span id="workbench-measure-readout" className="font-mono">
                    {`${measureText} mm`}
                  </span>
                )}
              </div>
            </section>
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
              projection={applied === null ? null : applied.state.projection}
              onSettled={() => {
                // Settle protocol: pixels may be compared only once this
                // stamp agrees with the settled volume.
                document
                  .getElementById("workbench-root")
                  ?.setAttribute(
                    "data-cad-rendered-volume",
                    applied === null
                      ? ""
                      : applied.state.measurement.volume.toFixed(3),
                  );
                setRenderedFrames((frames) => frames + 1);
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
          <CadParameterPanel className="w-60 shrink-0" />
        </div>
      </div>
      {/* Status bar: the settled numbers the operator works against. The
          status and volume spans are written by the worker session's
          surface writer (the fixture pattern); the rest mirror the store. */}
      <div className="border-border bg-background text-muted-foreground flex h-7 shrink-0 items-center gap-4 border-t px-3 font-mono text-xs">
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
