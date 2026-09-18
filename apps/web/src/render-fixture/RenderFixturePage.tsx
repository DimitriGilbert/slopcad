/**
 * The Phase 13 browser fixture: the Phase 12 selection surface re-hosted on
 * the headless CAD tool system, plus the tool interaction surface.
 *
 * ## Pipeline
 *
 * The real Manifold kernel executing in a real module Web Worker computes
 * the plate; the measurement converts through the public cad-core projection
 * boundary into a {@link RenderProjection} with its deterministic camera
 * spec; the cad-r3f `CadScene` renders it under demand-frameloop
 * discipline. On top of that, the fixture now boots a cad-core tool runtime
 * (session + selection + projection) and a tool manager (one active tool)
 * and feeds them NORMALIZED events — this page is the R3F adapter: DOM
 * pointer/keyboard activity plus scene picks become `ToolInputEvent` data,
 * dispatched to the manager. Tools never see the DOM.
 *
 * ## Tools (select / measure / translate / rotate)
 *
 * - The manager's machine-readable surface (phase, tool state, completion,
 *   failures) and the runtime's command log are published as `data-*`
 *   attributes on `#render-root`, written at the exact moment their fact
 *   becomes true.
 * - SELECT (default, armed at boot): click replaces the selection,
 *   shift-click toggles, pointer moves drive the hover — the Phase 12
 *   surface semantics, now issued as selection operations through the tool
 *   context.
 * - MEASURE: two picks complete with the distance as a dimensional value;
 *   the readout renders canonical millimetres with the unit.
 * - TRANSLATE: drag from one point on the model to another; the tool
 *   commits ONE atomic `parameter.set` transaction (x, y, z) on the
 *   document's translate feature. The fixture then re-derives the rendered
 *   projection with the document's applied translation offset — the
 *   fixture's stand-in for the (future) document executor. Volume is
 *   invariant under translation and the readout stays the kernel's.
 * - ROTATE: drag an arc; the tool commits the angle parameter
 *   transaction. NO geometry rotates — every kernel declares
 *   `transformRotation: false` and no document executor exists; the
 *   command lives in the document and its history, honestly inert.
 * - Cancellation: Escape or the cancel button cancels the live activation;
 *   per the manager's pinned atomicity rule, an in-flight drag emits
 *   nothing.
 *
 * ## Machine-readable surface
 *
 * Phase 12 attributes (unchanged): `data-volume`, `data-cad-rendered-volume`,
 * `data-selection`, `data-selection-key`, `data-cad-selection-frame`,
 * `data-hover`, `data-selection-regeneration`, `data-face-anchors`.
 * Phase 13 additions: `data-tool-id`, `data-tool-phase`, `data-tool-state`,
 * `data-tool-completion`, `data-tool-failure`, `data-command-log`
 * (canonical serializations of every issued transaction, in order),
 * `data-measure` (the measure readout in mm), `data-translate` (the
 * applied translation offset), `data-rendered-frames` (settle counter).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createSelectionState,
  createToolManager,
  createToolRuntime,
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
  valueIn,
  type SelectionReference,
  type SelectionState,
  type SerializedCadTransaction,
  type ToolCompletion,
  type ToolInputEvent,
  type ToolManager,
  type ToolManagerPhase,
  type ToolRuntime,
} from "@slopcad/cad-core";
import {
  CadScene,
  toolKeyEvent,
  toolModifiersFromNative,
  toolPointerEvent,
} from "@slopcad/cad-r3f";
import type { CadPick, CadPickCategory } from "@slopcad/cad-r3f";

import {
  appliedTranslationOffset,
  createFixtureSession,
} from "./fixture-document";
import {
  bootRenderFixtureSession,
  completionJson,
  faceAnchorSurface,
  selectionJson,
  type RenderFixtureSession,
} from "./fixture-session";
import {
  offsetPlateRenderState,
  type PlateRenderState,
} from "./plate-render-scene";
import {
  PLATE_HOLE_DIAMETER_DEFAULT_MM,
  PLATE_HOLE_DIAMETER_MAX_MM,
  PLATE_HOLE_DIAMETER_MIN_MM,
} from "../worker-fixture/plate-scene";

/** An applied computation: the render state plus its revision identity. */
interface AppliedRenderState {
  readonly state: PlateRenderState;
  readonly revision: number;
}

/** The tool manager surface mirrored into React for the DOM attributes. */
interface ToolSurfaceView {
  readonly phase: ToolManagerPhase;
  readonly toolId: string | null;
  readonly toolStateJson: string;
  readonly completion: ToolCompletion | null;
  readonly failureJson: string;
  readonly commandLogJson: string;
}

const INITIAL_TOOL_VIEW: ToolSurfaceView = {
  phase: "inactive",
  toolId: null,
  toolStateJson: "null",
  completion: null,
  failureJson: "",
  commandLogJson: "[]",
};

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

function sameVector(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

export function RenderFixturePage() {
  const [holeDiameter, setHoleDiameter] = useState(
    PLATE_HOLE_DIAMETER_DEFAULT_MM,
  );
  const [workerState, setWorkerState] = useState<AppliedRenderState | null>(
    null,
  );
  const [selection, setSelection] = useState<SelectionState>(() =>
    createSelectionState(0),
  );
  const [hover, setHover] = useState<SelectionReference | null>(null);
  const [pickCategory, setPickCategory] = useState<CadPickCategory>("face");
  const [toolView, setToolView] = useState<ToolSurfaceView>(INITIAL_TOOL_VIEW);
  const [translateOffset, setTranslateOffset] = useState<
    readonly [number, number, number]
  >([0, 0, 0]);
  const [renderedFrames, setRenderedFrames] = useState(0);

  const runtimeRef = useRef<ToolRuntime | null>(null);
  const managerRef = useRef<ToolManager | null>(null);
  const commandLogRef = useRef<SerializedCadTransaction[]>([]);
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
  const sessionRef = useRef<RenderFixtureSession | null>(null);

  if (runtimeRef.current === null) {
    runtimeRef.current = createToolRuntime({
      session: createFixtureSession(),
      selection: createSelectionState(0),
      onTransaction: (transaction) => {
        commandLogRef.current = [...commandLogRef.current, transaction];
      },
    });
  }
  if (managerRef.current === null) {
    managerRef.current = createToolManager({
      context: runtimeRef.current,
      tools: [
        registerTool(selectTool),
        registerTool(measureTool),
        registerTool(translateTool),
        registerTool(rotateTool),
      ],
    });
  }

  /** Mirrors the runtime's and manager's surfaces into React state. */
  const syncSurface = useCallback((): void => {
    const manager = managerRef.current;
    const runtime = runtimeRef.current;
    if (manager === null || runtime === null) return;
    setToolView({
      phase: manager.phase,
      toolId: manager.toolId,
      toolStateJson: JSON.stringify(manager.toolState),
      completion: manager.completion,
      failureJson:
        manager.failure === null ? "" : JSON.stringify(manager.failure),
      commandLogJson: JSON.stringify(commandLogRef.current),
    });
    setSelection(runtime.selection);
    setHover(runtime.selection.hover);
    const offset = appliedTranslationOffset(runtime.session.document);
    setTranslateOffset((previous) =>
      sameVector(previous, offset) ? previous : offset,
    );
  }, []);

  /** Dispatches one normalized event to the active tool, if any. */
  const dispatchTool = useCallback(
    (event: ToolInputEvent): void => {
      const manager = managerRef.current;
      if (manager === null || manager.phase !== "active") return;
      manager.dispatch(event);
      syncSurface();
    },
    [syncSurface],
  );

  /** Arms a tool: cancel-if-active, reset, activate — explicit transitions. */
  const armTool = useCallback(
    (toolId: string): void => {
      const manager = managerRef.current;
      if (manager === null) return;
      if (manager.phase === "active") manager.cancel();
      manager.reset();
      manager.activate(toolId);
      syncSurface();
    },
    [syncSurface],
  );

  /** Cancels the live activation (the pinned atomicity rule applies). */
  const cancelTool = useCallback((): void => {
    const manager = managerRef.current;
    if (manager === null || manager.phase !== "active") return;
    manager.cancel();
    syncSurface();
  }, [syncSurface]);

  useEffect(() => {
    // The host's explicit boot configuration: the SELECT tool armed.
    armTool(SELECT_TOOL_ID);
    const session = bootRenderFixtureSession(
      {
        rootId: "render-root",
        statusId: "render-status",
        volumeId: "render-volume",
        boundsId: "render-bounds",
        trianglesId: "render-triangles",
        revisionsId: "render-revisions",
        errorId: "render-error",
      },
      (state, revision) => {
        setWorkerState({ state, revision });
        // The applied revision is a NEW regeneration: synthetic references
        // die with the old one (transience), stable references persist.
        runtimeRef.current?.beginSelectionRegeneration(revision);
        syncSurface();
      },
    );
    sessionRef.current = session;
    session.dispatch(PLATE_HOLE_DIAMETER_DEFAULT_MM);
    return () => {
      sessionRef.current = null;
      session.dispose();
    };
  }, [armTool, syncSurface]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        cancelTool();
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
  }, [cancelTool, dispatchTool]);

  /** The worker state with the document's applied translation applied. */
  const applied = useMemo(() => {
    if (workerState === null) return null;
    if (sameVector(translateOffset, [0, 0, 0])) return workerState;
    return {
      revision: workerState.revision,
      state: offsetPlateRenderState(workerState.state, translateOffset),
    };
  }, [translateOffset, workerState]);

  const faceAnchors = useMemo(
    () => (applied === null ? "" : faceAnchorSurface(applied.state)),
    [applied],
  );

  // The host pushes the CURRENT projection (worker output plus the applied
  // translate offset) into the runtime — the projection access tools use
  // for measurements and rotation centers. Host-side state push, not a
  // tool side effect.
  useEffect(() => {
    runtimeRef.current?.setProjection(
      applied === null ? null : applied.state.projection,
    );
  }, [applied]);

  const measureText =
    toolView.completion !== null &&
    toolView.completion.detail.kind === "measurement"
      ? `${valueIn(toolView.completion.detail.distance, "mm").toFixed(3)} mm`
      : "";

  const tools = [
    { id: SELECT_TOOL_ID, label: "Select" },
    { id: MEASURE_TOOL_ID, label: "Measure" },
    { id: TRANSLATE_TOOL_ID, label: "Translate" },
    { id: ROTATE_TOOL_ID, label: "Rotate" },
  ];

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
      data-cad-rendered-translate=""
      data-selection={JSON.stringify(
        selection.selected.map(serializeSelectionReference),
      )}
      data-selection-key={selection.selected
        .map(selectionReferenceKey)
        .join(";")}
      data-cad-selection-frame=""
      data-hover={hover === null ? "" : selectionJson(hover)}
      data-selection-regeneration={String(selection.regeneration)}
      data-tool-id={toolView.toolId ?? ""}
      data-tool-phase={toolView.phase}
      data-tool-state={toolView.toolStateJson}
      data-tool-completion={
        toolView.completion === null ? "" : completionJson(toolView.completion)
      }
      data-tool-failure={toolView.failureJson}
      data-command-log={toolView.commandLogJson}
      data-measure={measureText}
      data-translate={JSON.stringify(translateOffset)}
      data-rendered-frames={String(renderedFrames)}
      data-error=""
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 13 Tool Fixture (deterministic scene)
        </h1>
        <p className="text-muted-foreground text-sm">
          Real Manifold worker → plate → render projection → deterministic CAD
          scene, driven by headless CAD tools: select (click replaces,
          shift-click toggles), measure (two picks), translate (drag; commits a
          parameter.set transaction and moves the plate), rotate (drag; commits
          the angle command — no kernel executes rotations today). Escape
          cancels a live gesture.
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
            <legend className="font-medium">Tool</legend>
            <div className="flex flex-wrap gap-1">
              {tools.map((tool) => (
                <button
                  key={tool.id}
                  id={`tool-${tool.id}`}
                  className="border-input bg-background rounded border px-2 py-1 text-xs"
                  type="button"
                  onClick={() => {
                    armTool(tool.id);
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
                  cancelTool();
                }}
              >
                Cancel tool
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
                runtimeRef.current?.applySelection({ type: "clear" });
                syncSurface();
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
            <li>
              tool ={" "}
              <span id="tool-status">{`${toolView.toolId ?? "none"} (${toolView.phase})`}</span>
            </li>
            <li>
              measure ={" "}
              <span id="measure-readout">
                {measureText === "" ? "—" : measureText}
              </span>
            </li>
            <li>
              translate ={" "}
              <span id="translate-readout">{`[${translateOffset.join(", ")}]`}</span>
            </li>
            <li>
              commands ={" "}
              <span id="command-count">
                {String(commandLogRef.current.length)}
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
            scene's dpr={1}). The CAPTURE-phase pointer listeners snapshot
            the DOM modifiers BEFORE the scene's raycast handlers dispatch
            tool events; the bubble-phase listeners emit the empty-space
            down/up events the scene could not resolve. */}
        <div
          id="render-viewport"
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
              toolPointerEvent(
                "pointer-up",
                null,
                toolModifiersFromNative(event),
              ),
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
                const root = document.getElementById("render-root");
                root?.setAttribute(
                  "data-cad-rendered-volume",
                  applied.state.measurement.volume.toFixed(3),
                );
                // Settle identity for the translate stand-in: WHICH offset
                // the settled frame rendered, so tests can wait for the
                // moved frame precisely (the volume stamp alone cannot
                // distinguish it — translation is volume-invariant).
                root?.setAttribute(
                  "data-cad-rendered-translate",
                  JSON.stringify(translateOffset),
                );
                setRenderedFrames((frames) => frames + 1);
              }}
              regeneration={applied.revision}
              selection={selection.selected}
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
