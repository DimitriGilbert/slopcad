/**
 * The Phase 14 workbench fixture: the SAME interaction surface as the Phase
 * 13 `/render` fixture, re-hosted on the `@slopcad/cad-react` provider and
 * hooks. Every interaction flows through the hook layer — parameter edits
 * through `useCadParameters` (expression-aware, committed as `parameter.set`
 * transactions), tool activation and tool events through `useCadTools`,
 * selection state through `useCadSelection`, undo/redo through
 * `useCadHistory` — and the page holds NO canonical state of its own: React
 * mirrors what the domain reports.
 *
 * ## Pipeline
 *
 * Real Manifold worker → plate → render projection → cad-r3f `CadScene`
 * (prop-driven, as documented in cad-r3f). The page's executor stand-in:
 * an effect watches the document's hole parameter (through the hook) and
 * re-dispatches the worker computation with the document's stored value, so
 * hook edits, undo, and redo all visibly settle — and the machine-readable
 * surfaces prove the DOCUMENT is what changed: `data-command-log` carries
 * the canonical serialized transactions, `data-hole-diameter` the document's
 * stored value, `data-history` the history view.
 *
 * The parameter input is expression-aware: it accepts the domain's V1
 * expression syntax ("6mm", "holeDiameter * 2") with one page-side
 * convenience — a bare number is read as millimetres. A parse, evaluation,
 * or commit failure is surfaced as its stable code in `data-param-error`
 * and issues nothing.
 *
 * ## Machine-readable surface (`#workbench-root`)
 *
 * Phase 14 additions: `data-command-log`, `data-hole-diameter`,
 * `data-history`, `data-param-error`. Inherited from the Phase 12/13
 * fixtures: `data-volume`, `data-cad-rendered-volume`, `data-in-flight`,
 * `data-applied-revision`, `data-current-revision`, `data-selection`,
 * `data-selection-key`, `data-selection-regeneration`, `data-hover`,
 * `data-tool-id`, `data-tool-phase`, `data-tool-state`,
 * `data-tool-completion`, `data-tool-failure`, `data-measure`,
 * `data-translate` (the document's translate offset, read from its own
 * parameters — no render stand-in), `data-rendered-frames`, `data-error`,
 * `data-face-anchors`.
 *
 * Execution scope (honest, like `/render`): the translate/rotate tools are
 * registered and their gestures issue real transactions into the document
 * and its history, and undo/redo move them, but no kernel executes
 * transforms — the rendered geometry follows ONLY the hole parameter.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  CadProvider,
  createCadStore,
  measureTool,
  MEASURE_TOOL_ID,
  registerTool,
  rotateTool,
  ROTATE_TOOL_ID,
  selectTool,
  SELECT_TOOL_ID,
  selectionReferenceKey,
  serializeSelectionReference,
  translateTool,
  TRANSLATE_TOOL_ID,
  useCadDocument,
  useCadHistory,
  useCadParameters,
  useCadSelection,
  useCadStore,
  useCadTools,
  valueIn,
  type SelectionReference,
  type ToolInputEvent,
} from "@slopcad/cad-react";
import {
  CadScene,
  toolKeyEvent,
  toolModifiersFromNative,
  toolPointerEvent,
} from "@slopcad/cad-r3f";
import type { CadPick, CadPickCategory } from "@slopcad/cad-r3f";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import {
  bootRenderFixtureSession,
  completionJson,
  faceAnchorSurface,
  type RenderFixtureSession,
} from "../render-fixture/fixture-session";
import { appliedTranslationOffset } from "../render-fixture/fixture-document";
import { PLATE_HOLE_DIAMETER_DEFAULT_MM } from "../worker-fixture/plate-scene";
import {
  createWorkbenchSession,
  holeDiameterMm,
  WORKBENCH_HOLE_PARAMETER,
} from "./workbench-document";

/** An applied computation: the render state plus its revision identity. */
interface AppliedRenderState {
  readonly state: PlateRenderState;
  readonly revision: number;
}

/** The tools the workbench registers, with button labels. */
const WORKBENCH_TOOLS = [
  { id: SELECT_TOOL_ID, label: "Select" },
  { id: MEASURE_TOOL_ID, label: "Measure" },
  { id: TRANSLATE_TOOL_ID, label: "Translate" },
  { id: ROTATE_TOOL_ID, label: "Rotate" },
] as const;

export function WorkbenchFixturePage() {
  // The store is composed ONCE from the fixture's domain instances (session
  // + tool registry); the provider hands it to the hooks below. The page
  // never constructs domain state outside this factory call and never
  // mutates it outside the store's operations.
  const [store] = useState(() =>
    createCadStore({
      session: createWorkbenchSession(PLATE_HOLE_DIAMETER_DEFAULT_MM),
      tools: [
        registerTool(selectTool),
        registerTool(measureTool),
        registerTool(translateTool),
        registerTool(rotateTool),
      ],
    }),
  );

  return (
    <CadProvider store={store}>
      <WorkbenchBody />
    </CadProvider>
  );
}

function WorkbenchBody(): ReactElement {
  // Every hook mirrors one concern; the stable operation identities come
  // straight from the store.
  const store = useCadStore("WorkbenchFixturePage");
  const documentApi = useCadDocument();
  const parametersApi = useCadParameters();
  const selectionApi = useCadSelection();
  const toolsApi = useCadTools();
  const historyApi = useCadHistory();
  const { arm, cancel, dispatch } = toolsApi;
  const { beginRegeneration } = selectionApi;

  const [applied, setApplied] = useState<AppliedRenderState | null>(null);
  const [pickCategory, setPickCategory] = useState<CadPickCategory>("face");
  const [holeInput, setHoleInput] = useState(
    String(PLATE_HOLE_DIAMETER_DEFAULT_MM),
  );
  const [paramError, setParamError] = useState("");
  const [renderedFrames, setRenderedFrames] = useState(0);

  const sessionRef = useRef<RenderFixtureSession | null>(null);
  const modifiersRef = useRef<ReturnType<typeof toolModifiersFromNative>>(
    toolModifiersFromNative({
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    }),
  );
  const downWithPickRef = useRef(false);
  const upWithPickRef = useRef(false);

  const storedHole = holeDiameterMm(documentApi.document);

  /** Dispatches one normalized event to the active tool, if any. */
  const dispatchTool = useCallback(
    (event: ToolInputEvent): void => {
      if (toolsApi.phase !== "active") return;
      dispatch(event);
    },
    [dispatch, toolsApi.phase],
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
        // The applied revision is a NEW regeneration: synthetic references
        // die with the old one (transience), stable references persist.
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

  // The executor stand-in: the document's hole parameter is the source of
  // truth; the worker computation follows it. Hook edits, undo, and redo
  // all move the stored value, so all of them re-dispatch through here.
  useEffect(() => {
    if (storedHole === null) return;
    sessionRef.current?.dispatch(storedHole);
  }, [storedHole]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        cancel();
        return;
      }
      dispatchTool(
        toolKeyEvent("key-down", event.key, toolModifiersFromNative(event)),
      );
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      dispatchTool(
        toolKeyEvent("key-up", event.key, toolModifiersFromNative(event)),
      );
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [cancel, dispatchTool]);

  // The host pushes the CURRENT projection into the store — the projection
  // access the active tool reads for measurements. Host-side state push,
  // not a tool side effect.
  useEffect(() => {
    store.setProjection(applied === null ? null : applied.state.projection);
  }, [applied, store]);

  /** Applies the parameter input as an expression through the hook. */
  const applyHoleInput = useCallback(() => {
    // Page-side convenience: a bare number is millimetres (see module doc).
    const source = /^\d+(\.\d+)?$/.test(holeInput.trim())
      ? `${holeInput.trim()}mm`
      : holeInput;
    const outcome = parametersApi.setValueFromExpression(
      WORKBENCH_HOLE_PARAMETER,
      source,
    );
    setParamError(outcome.ok ? "" : outcome.error.code);
  }, [holeInput, parametersApi]);

  const measureText =
    toolsApi.completion !== null &&
    toolsApi.completion.detail.kind === "measurement"
      ? `${valueIn(toolsApi.completion.detail.distance, "mm").toFixed(3)} mm`
      : "";

  const selectionKey = useMemo(
    () => selectionApi.selected.map(selectionReferenceKey).join(";"),
    [selectionApi.selected],
  );

  // The document's translate offset, read back from its translate feature's
  // parameters — real document data on the shared tool surface (the render
  // has no translate stand-in on this fixture; the scene follows only the
  // hole parameter).
  const translateOffset = useMemo(
    () => appliedTranslationOffset(documentApi.document),
    [documentApi.document],
  );

  const faceAnchors = useMemo(
    () => (applied === null ? "" : faceAnchorSurface(applied.state)),
    [applied],
  );

  return (
    <div
      id="workbench-root"
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      data-volume=""
      data-cad-rendered-volume=""
      data-in-flight="0"
      data-applied-revision=""
      data-current-revision="0"
      data-selection={JSON.stringify(
        selectionApi.selected.map(serializeSelectionReference),
      )}
      data-selection-key={selectionKey}
      data-selection-regeneration={String(selectionApi.regeneration)}
      data-hover={
        selectionApi.hover === null ? "" : JSON.stringify(serializeSelectionReference(selectionApi.hover))
      }
      data-tool-id={toolsApi.activeToolId ?? ""}
      data-tool-phase={toolsApi.phase}
      data-tool-state={JSON.stringify(toolsApi.toolState)}
      data-tool-completion={
        toolsApi.completion === null ? "" : completionJson(toolsApi.completion)
      }
      data-tool-failure={
        toolsApi.failure === null ? "" : JSON.stringify(toolsApi.failure)
      }
      data-command-log={JSON.stringify(store.commandLog)}
      data-hole-diameter={storedHole === null ? "" : String(storedHole)}
      data-history={JSON.stringify({
        canUndo: historyApi.canUndo,
        canRedo: historyApi.canRedo,
        cursor: historyApi.cursor,
        depth: historyApi.depth,
      })}
      data-param-error={paramError}
      data-measure={measureText}
      data-translate={JSON.stringify(translateOffset)}
      data-rendered-frames={String(renderedFrames)}
      data-error=""
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 14 Workbench Fixture (hook-driven)
        </h1>
        <p className="text-muted-foreground text-sm">
          The /render interaction surface re-hosted on the cad-react provider
          and hooks: parameter edits commit parameter.set transactions through
          useCadParameters (expressions welcome; bare numbers are mm), undo and
          redo run through useCadHistory, tool activation and gestures through
          useCadTools, selection through useCadSelection. The scene follows the
          document&apos;s holeDiameter parameter; translate/rotate gestures
          commit honest, inert document history.
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div className="w-64 shrink-0 space-y-4">
          <label className="block text-sm" htmlFor="param-holeDiameter">
            <span className="mb-1 block font-medium">
              holeDiameter (mm or expression)
            </span>
            <input
              id="param-holeDiameter"
              className="border-input bg-background w-full rounded border px-2 py-1 font-mono"
              type="text"
              value={holeInput}
              onChange={(event) => {
                setHoleInput(event.target.value);
              }}
            />
          </label>
          <div className="flex gap-1">
            <button
              id="param-apply"
              className="border-input bg-background rounded border px-2 py-1 text-xs"
              type="button"
              onClick={applyHoleInput}
            >
              Apply
            </button>
            <span id="param-error" className="text-xs text-red-500">
              {paramError}
            </span>
          </div>
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">Tool</legend>
            <div className="flex flex-wrap gap-1">
              {WORKBENCH_TOOLS.map((tool) => (
                <button
                  key={tool.id}
                  id={`tool-${tool.id}`}
                  className="border-input bg-background rounded border px-2 py-1 text-xs"
                  type="button"
                  onClick={() => {
                    arm(tool.id);
                  }}
                >
                  {tool.label}
                </button>
              ))}
              <button
                id="tool-cancel"
                className="border-input bg-background rounded border px-2 py-1 text-xs"
                type="button"
                onClick={() => {
                  cancel();
                }}
              >
                Cancel tool
              </button>
            </div>
          </fieldset>
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">History</legend>
            <div className="flex gap-1">
              <button
                id="history-undo"
                className="border-input bg-background rounded border px-2 py-1 text-xs"
                type="button"
                disabled={!historyApi.canUndo}
                onClick={() => {
                  historyApi.undo();
                }}
              >
                Undo
              </button>
              <button
                id="history-redo"
                className="border-input bg-background rounded border px-2 py-1 text-xs"
                type="button"
                disabled={!historyApi.canRedo}
                onClick={() => {
                  historyApi.redo();
                }}
              >
                Redo
              </button>
            </div>
          </fieldset>
          <fieldset className="space-y-1 text-sm">
            <legend className="font-medium">Pick category</legend>
            <label className="block" htmlFor="pick-category-face">
              <input
                id="pick-category-face"
                className="mr-1"
                type="radio"
                name="workbench-pick-category"
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
                name="workbench-pick-category"
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
                selectionApi.clear();
              }}
            >
              Clear selection
            </button>
          </div>
          <ul className="space-y-1 font-mono text-xs">
            <li>
              status = <span id="workbench-status">boot</span>
            </li>
            <li>
              volume = <span id="workbench-volume">…</span>
              {"\u00A0"}mm³
            </li>
            <li>
              tool ={" "}
              <span id="workbench-tool-status">
                {`${toolsApi.activeToolId ?? "none"} (${toolsApi.phase})`}
              </span>
            </li>
            <li>
              measure ={" "}
              <span id="workbench-measure-readout">
                {measureText === "" ? "—" : measureText}
              </span>
            </li>
            <li>
              commands ={" "}
              <span id="workbench-command-count">
                {String(store.commandLog.length)}
              </span>
            </li>
            <li data-testid="workbench-error" className="text-red-500">
              <span id="workbench-error" />
            </li>
          </ul>
          <div className="text-sm">
            <span className="font-medium">Selection</span>
            <ul id="workbench-selection-list" className="font-mono text-xs">
              {selectionApi.selected.map((reference) => (
                <li key={selectionReferenceKey(reference)}>
                  {selectionLabel(reference)}
                </li>
              ))}
            </ul>
          </div>
        </div>
        {/* Fixed pixel box: part of the determinism contract (the camera
            spec is authored for this exact viewport; DPR comes from the
            scene's dpr={1}). The CAPTURE-phase pointer listeners snapshot
            the DOM modifiers BEFORE the scene's raycast handlers dispatch
            tool events; the bubble-phase listeners emit the empty-space
            down/up events the scene could not resolve. */}
        <div
          id="workbench-viewport"
          className="h-[520px] w-[800px] shrink-0 overflow-hidden border"
          data-face-anchors={faceAnchors}
          onPointerDownCapture={(event) => {
            modifiersRef.current = toolModifiersFromNative(event);
            downWithPickRef.current = false;
          }}
          onPointerUpCapture={(event) => {
            modifiersRef.current = toolModifiersFromNative(event);
            upWithPickRef.current = false;
          }}
          onPointerDown={(event) => {
            if (downWithPickRef.current) return;
            dispatchTool(
              toolPointerEvent(
                "pointer-down",
                null,
                toolModifiersFromNative(event),
              ),
            );
          }}
          onPointerUp={(event) => {
            if (upWithPickRef.current) return;
            dispatchTool(
              toolPointerEvent("pointer-up", null, toolModifiersFromNative(event)),
            );
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
                  .getElementById("workbench-root")
                  ?.setAttribute(
                    "data-cad-rendered-volume",
                    applied.state.measurement.volume.toFixed(3),
                  );
                setRenderedFrames((frames) => frames + 1);
              }}
              regeneration={applied.revision}
              selection={selectionApi.selected}
              pickCategory={pickCategory}
              onPickDown={(pick: CadPick) => {
                downWithPickRef.current = true;
                dispatchTool(
                  toolPointerEvent("pointer-down", pick, modifiersRef.current),
                );
              }}
              onPickUp={(pick: CadPick) => {
                upWithPickRef.current = true;
                dispatchTool(
                  toolPointerEvent("pointer-up", pick, modifiersRef.current),
                );
              }}
              onHover={(pick: CadPick | null) => {
                dispatchTool(
                  toolPointerEvent("pointer-move", pick, modifiersRef.current),
                );
              }}
              onSelectionRendered={(key) => {
                document
                  .getElementById("workbench-root")
                  ?.setAttribute("data-cad-selection-frame", key);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/** Human-readable label of a selection reference for the workbench's list. */
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
