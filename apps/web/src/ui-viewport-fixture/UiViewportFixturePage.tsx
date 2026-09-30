/**
 * The Phase 15.1/15.2/15.3/15.4 `/ui-viewport` fixture: the plate render
 * pipeline (the same Manifold worker session as `/render` and
 * `/workbench`) drawn through the `@slopcad/ui` `CadViewport` component
 * instead of hand-wired scene plumbing, with the `CadToolbar` component
 * mounted above it, the `CadModelTree` mounted beside it, and the
 * `CadParameterPanel` mounted beside the tree. The page composes the
 * provider store (all four built-in tools registered) and boots the
 * worker — everything else (selection mirroring, regeneration identity,
 * pick normalization, tool dispatch, keyboard, parameter editing) is the
 * components' own provider-driven behavior: the page passes NO selection
 * props, NO pick callbacks, NO toolbar props, and NO panel props, so the
 * browser evidence covers the default wiring end to end. The tree receives
 * exactly ONE prop — the regeneration state map — because statuses are
 * PROP-ONLY (no store concern carries them): the map is derived from the
 * document through the domain's own `regenerate` orchestration with the
 * fixture's executor stand-in, which fails the translate feature when a
 * translation component goes negative (the two buttons under the tree drive
 * that parameter through `parameter.set` — the forced-failure path).
 *
 * The fixture document extends the workbench document with one
 * expression-driven parameter (`volumeHint` = `holeDiameter * 2`, cached at
 * the matching 16 mm) so the panel's expression display and expression
 * editing have real domain data; the cached value goes stale when
 * `holeDiameter` moves — the domain's own semantics (recomputation is the
 * regeneration pipeline's job, never the panel's).
 *
 * Machine-readable surface (`#ui-viewport-root`): the settle attributes the
 * worker session writes (`data-in-flight`, `data-applied-revision`,
 * `data-current-revision`, `data-volume`, `data-error`), the viewport's
 * settle stamps (`data-cad-rendered-volume` from `onSettled`,
 * `data-cad-selection-frame` from `onSelectionRendered`), the mirrored
 * domain state (`data-selection-key`, `data-tool-id`, `data-tool-phase`),
 * `data-command-log` (the store's canonical serialized transactions), and
 * `data-rendered-frames`, plus `data-face-anchors` on `#ui-viewport` (the
 * deterministic click targets, relative to the viewport's 800×520 CSS box —
 * the size the fixture camera spec is authored for).
 *
 * The overlay demonstrates the documented slot: a pointer-transparent
 * status chip pair mirroring provider state, and a Clear-selection button
 * that opts into pointer events and clears the selection through the
 * domain. The SELECT tool is armed at boot, so viewport picks flow through
 * the tool surface (the select tool applies the Phase 12 selection ops);
 * the toolbar switches the live tool through the store's arm operation.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  CadProvider,
  createCadStore,
  createSession,
  length,
  measureTool,
  registerTool,
  rotateTool,
  selectTool,
  SELECT_TOOL_ID,
  selectionReferenceKey,
  translateTool,
  useCadDocument,
  useCadParameters,
  useCadSelection,
  useCadStore,
  useCadTools,
} from "@slopcad/cad-react";
import { Button } from "@slopcad/ui/components/button";
import { CadModelTree } from "@slopcad/ui/components/cad/cad-model-tree";
import { CadParameterPanel } from "@slopcad/ui/components/cad/cad-parameter-panel";
import { CadToolbar } from "@slopcad/ui/components/cad/cad-toolbar";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";

import {
  bootRenderFixtureSession,
  faceAnchorSurface,
  type FixtureRenderState,
  type RenderFixtureSession,
} from "../render-fixture/fixture-session";
import { PLATE_HOLE_DIAMETER_DEFAULT_MM } from "../worker-fixture/plate-scene";
import {
  createWorkbenchSession,
  holeDiameterMm,
} from "../workbench-fixture/workbench-document";
import {
  deriveWorkbenchRegenerationStates,
  workbenchDocumentWithVolumeHint,
} from "../workbench-fixture/workbench-extended-document";

/** An applied computation: the render state plus its revision identity. */
interface AppliedRenderState {
  readonly state: FixtureRenderState;
  readonly revision: number;
}

export function UiViewportFixturePage(): ReactElement {
  // The store is composed ONCE from the fixture's domain instances; the
  // provider hands it to the hooks — and to the CadViewport below. The
  // session wraps the workbench document extended with the expression-driven
  // volumeHint parameter (see workbenchDocumentWithVolumeHint).
  const [store] = useState(() =>
    createCadStore({
      session: createSession(
        workbenchDocumentWithVolumeHint(
          createWorkbenchSession(PLATE_HOLE_DIAMETER_DEFAULT_MM).document,
        ),
      ),
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
      <UiViewportBody />
    </CadProvider>
  );
}

function UiViewportBody(): ReactElement {
  const store = useCadStore("UiViewportFixturePage");
  const selectionApi = useCadSelection();
  const toolsApi = useCadTools();
  const parametersApi = useCadParameters();
  const { arm } = toolsApi;
  const { beginRegeneration } = selectionApi;

  const [applied, setApplied] = useState<AppliedRenderState | null>(null);
  const [renderedFrames, setRenderedFrames] = useState(0);
  const sessionRef = useRef<RenderFixtureSession | null>(null);

  // The executor stand-in: the document's hole parameter is the source of
  // truth; the worker computation follows it (the same pipeline as the
  // /render and /workbench fixtures).
  const storedHole = holeDiameterMm(useCadDocument().document);

  // The regeneration states: derived from the CURRENT document through the
  // domain's regenerate orchestration (see the shared executor stand-in).
  const { document: cadDocument } = useCadDocument();
  const regenerationStates = useMemo(
    () => deriveWorkbenchRegenerationStates(cadDocument),
    [cadDocument],
  );

  // The forced-failure path: the translate feature's x component. A
  // negative length is dimensionally valid but fails the executor stand-in.
  const translateX = parametersApi.getByName("translate_x");

  useEffect(() => {
    // The host's explicit boot configuration: the SELECT tool armed through
    // the hook layer (cancel-if-active, reset, activate).
    arm(SELECT_TOOL_ID);
    const session = bootRenderFixtureSession(
      {
        rootId: "ui-viewport-root",
        statusId: "ui-viewport-status",
        volumeId: "ui-viewport-volume",
        errorId: "ui-viewport-error",
      },
      (state, revision) => {
        setApplied({ state, revision });
        // A NEW regeneration: synthetic references die with the old one.
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

  return (
    <div
      id="ui-viewport-root"
      className="mx-auto w-full max-w-6xl space-y-4 p-6"
      data-selection-key={selectionKey}
      data-tool-id={toolsApi.activeToolId ?? ""}
      data-tool-phase={toolsApi.phase}
      data-command-log={JSON.stringify(store.commandLog)}
      data-rendered-frames={String(renderedFrames)}
    >
      <div>
        <h1 className="text-lg font-semibold">
          Phase 15.1–15.4 CAD Viewport + Toolbar + Model Tree + Parameter Panel
          Fixture
        </h1>
        <p className="text-muted-foreground text-sm">
          The plate pipeline drawn through the CadViewport component in its
          provider-driven mode: no selection props, no pick callbacks — the
          viewport mirrors the selection concern and wires picks to the armed
          SELECT tool itself. The CadToolbar above mirrors the four registered
          tools and arms through the store. The CadModelTree beside the viewport
          mirrors the document and selection and picks through the store; its
          statuses come from the regeneration map derived with the domain&apos;s
          regenerate orchestration (a negative translation component fails the
          translate feature). The CadParameterPanel beside the tree mirrors the
          document&apos;s parameters and applies edits as parameter.set
          transactions through the store; expression fields are validated by the
          domain&apos;s own parser and evaluator. The overlay chip mirrors
          provider state; the Clear button applies the domain clear operation.
        </p>
      </div>
      <div className="flex flex-wrap items-start gap-6">
        <div id="ui-viewport-panel" className="space-y-2">
          {/* Provider-driven toolbar: no props — it mirrors the registry,
              presses the live tool, and arms through the store's arm op. */}
          <CadToolbar />
          <div id="ui-viewport" data-face-anchors={faceAnchors}>
            <CadViewport
              className="h-[520px] w-[800px]"
              projection={applied === null ? null : applied.state.projection}
              onSettled={() => {
                // Settle protocol: pixels may be compared only once this
                // stamp agrees with the settled volume.
                document
                  .getElementById("ui-viewport-root")
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
                  .getElementById("ui-viewport-root")
                  ?.setAttribute("data-cad-selection-frame", key);
              }}
              overlay={
                <>
                  <div className="absolute top-2 left-2 flex gap-2 font-mono text-[11px]">
                    <span className="border-border bg-background/85 rounded-none border px-2 py-1">
                      {`${toolsApi.activeToolId ?? "none"} · ${toolsApi.phase}`}
                    </span>
                    <span
                      id="ui-viewport-selection-count"
                      className="border-border bg-background/85 rounded-none border px-2 py-1"
                    >
                      {`${selectionApi.selected.length} selected`}
                    </span>
                  </div>
                  <Button
                    id="ui-viewport-clear"
                    variant="outline"
                    size="xs"
                    className="pointer-events-auto absolute top-2 right-2"
                    disabled={selectionApi.selected.length === 0}
                    onClick={() => {
                      selectionApi.clear();
                    }}
                  >
                    Clear selection
                  </Button>
                </>
              }
            />
          </div>
        </div>
        {/* The right rail: model tree over parameter panel — the workbench
            composition. Both mirror the store; nothing else on the page
            touches their state. */}
        <div className="flex w-72 shrink-0 flex-col gap-4">
          <div id="ui-tree-panel" className="space-y-2">
            {/* Provider-driven tree with one explicit prop: the regeneration
                states (statuses are PROP-ONLY — no store concern carries
                them). Document, selection, and picks all mirror the store. */}
            <CadModelTree
              regenerationStates={regenerationStates}
              className="w-72"
            />
            <div className="flex gap-2">
              <Button
                id="ui-tree-force-failure"
                variant="outline"
                size="xs"
                disabled={translateX === undefined}
                onClick={() => {
                  if (translateX !== undefined) {
                    parametersApi.setValue(translateX.id, length(-5));
                  }
                }}
              >
                Force translate failure
              </Button>
              <Button
                id="ui-tree-restore"
                variant="outline"
                size="xs"
                disabled={translateX === undefined}
                onClick={() => {
                  if (translateX !== undefined) {
                    parametersApi.setValue(translateX.id, length(0));
                  }
                }}
              >
                Restore translate
              </Button>
            </div>
          </div>
          <div id="ui-param-panel" className="space-y-2">
            {/* Provider-driven parameter panel: no props — it mirrors the
                document's parameters, validates expressions with the domain's
                own parser/evaluator, and applies edits as parameter.set
                transactions through the store. */}
            <CadParameterPanel className="w-72" />
          </div>
        </div>
        <ul className="space-y-1 font-mono text-xs">
          <li>
            status = <span id="ui-viewport-status">boot</span>
          </li>
          <li>
            volume = <span id="ui-viewport-volume">…</span>
            {"\u00A0"}mm³
          </li>
          <li>
            tool ={" "}
            <span id="ui-viewport-tool-readout">
              {`${toolsApi.activeToolId ?? "none"} (${toolsApi.phase})`}
            </span>
          </li>
          <li>
            selection ={" "}
            <span id="ui-viewport-selection-readout">{selectionKey}</span>
          </li>
          <li>
            frames ={" "}
            <span id="ui-viewport-frames-readout">
              {String(renderedFrames)}
            </span>
          </li>
          <li data-testid="ui-viewport-error" className="text-destructive">
            <span id="ui-viewport-error" />
          </li>
        </ul>
      </div>
    </div>
  );
}
