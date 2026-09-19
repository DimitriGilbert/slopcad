/**
 * The plate-workbench example (Phase 33.3): a COMPLETE CAD workbench
 * composition installed as one registry item — the four CAD UI components
 * (`CadToolbar`, `CadViewport`, `CadModelTree`, `CadParameterPanel`)
 * around one real provider store, the example's parametric plate document,
 * and a real Manifold-kernel geometry pipeline on the main thread. Every
 * parameter edit the panel applies comes back as a new document, a new
 * regeneration pass, and a new projected frame.
 *
 * This file composes ONLY registry-distributed modules (relative imports
 * that resolve identically in the authoring package and in an installed
 * consumer) and the public `@slopcad/cad-react` API.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  CadProvider,
  createCadStore,
  DIAGNOSTIC_CODES,
  initialRegenerationStates,
  measureTool,
  registerTool,
  regenerate,
  rotateTool,
  selectTool,
  SELECT_TOOL_ID,
  selectionReferenceKey,
  translateTool,
  useCadDocument,
  useCadSelection,
  useCadTools,
  type FeatureExecutionOutcome,
  type FeatureRecord,
  type RegenerationStateMap,
  type RenderProjection,
} from "@slopcad/cad-react";

import { Button } from "../../components/button";
import { CadModelTree } from "../../components/cad/cad-model-tree";
import { CadParameterPanel } from "../../components/cad/cad-parameter-panel";
import { CadToolbar } from "../../components/cad/cad-toolbar";
import { CadViewport } from "../../components/cad/cad-viewport";
import {
  createPlateSession,
  holeDiameterMmOf,
  translateComponentsMmOf,
} from "./plate-document";
import { buildPlateProjection } from "./plate-geometry";

/** The provider store, composed once from the example's session. */
function usePlateStore() {
  const [store] = useState(() =>
    createCadStore({
      session: createPlateSession(),
      tools: [
        registerTool(selectTool),
        registerTool(measureTool),
        registerTool(translateTool),
        registerTool(rotateTool),
      ],
    }),
  );
  return store;
}

/** The complete workbench: mount anywhere, no props. */
export function PlateWorkbench(): ReactElement {
  const store = usePlateStore();
  return (
    <CadProvider store={store}>
      <PlateWorkbenchBody />
    </CadProvider>
  );
}

function PlateWorkbenchBody(): ReactElement {
  const toolsApi = useCadTools();
  const selectionApi = useCadSelection();
  const { arm } = toolsApi;
  const { document: cadDocument } = useCadDocument();

  const [projection, setProjection] = useState<RenderProjection | null>(null);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [settledFrames, setSettledFrames] = useState(0);
  const [selectionFrame, setSelectionFrame] = useState<string>("");
  const [regenerationStates, setRegenerationStates] =
    useState<RegenerationStateMap>(() => new Map());

  // The document snapshot's object identity is not guaranteed stable across
  // polls, so the build effect keys on ONE PRIMITIVE string — the feature
  // graph shape plus the build's numeric inputs — and re-derives the values
  // from the latest document snapshot through the ref below.
  const documentRef = useRef(cadDocument);
  documentRef.current = cadDocument;
  const buildKey = useMemo(() => {
    const hole = holeDiameterMmOf(cadDocument);
    const translate = translateComponentsMmOf(cadDocument);
    if (hole === null || translate === null) return null;
    const featureKey = cadDocument.features
      .map((feature) => feature.id)
      .join(";");
    return `${featureKey}|${hole}|${translate.join("|")}`;
  }, [cadDocument]);

  useEffect(() => {
    arm(SELECT_TOOL_ID);
    // arm is a stable store operation identity: the boot arm runs once.
  }, [arm]);

  useEffect(() => {
    if (buildKey === null) return;
    const snapshot = documentRef.current;
    const holeDiameterMm = holeDiameterMmOf(snapshot);
    const translateMm = translateComponentsMmOf(snapshot);
    if (holeDiameterMm === null || translateMm === null) return;
    let cancelled = false;
    void buildPlateProjection({
      holeDiameterMm,
      translateMm,
    }).then((build) => {
      if (cancelled) return;
      // The regeneration executor replays this build's outcome for the
      // translate feature — the same kernel decision the viewport shows.
      const execute = (feature: FeatureRecord): FeatureExecutionOutcome => {
        if (feature.kind !== "translate" || build.ok) return { ok: true };
        return {
          ok: false,
          diagnostics: [
            {
              severity: "error",
              code: DIAGNOSTIC_CODES.kernelOperationFailed,
              message: `The plate build failed: ${build.error}`,
              location: { primary: feature.id },
            },
          ],
        };
      };
      const features = snapshot.features;
      const initial = initialRegenerationStates(features);
      const run = regenerate({
        features,
        states: initial,
        suppressed: [],
        execute,
      });
      setRegenerationStates(run.ok ? run.value.states : initial);
      setBuildError(build.ok ? null : build.error);
      setProjection(build.ok ? build.projection : null);
    });
    return () => {
      cancelled = true;
    };
  }, [buildKey]);

  const selectionKey = useMemo(
    () => selectionApi.selected.map(selectionReferenceKey).join(";"),
    [selectionApi.selected],
  );

  return (
    <div id="plate-workbench-root" className="w-full max-w-6xl space-y-4">
      <div className="flex w-full flex-wrap items-start gap-6">
        <div className="space-y-2">
          <CadToolbar />
          <div id="plate-viewport" className="relative">
            <CadViewport
              className="h-[520px] w-[800px]"
              projection={projection}
              onSettled={() => {
                setSettledFrames((frames) => frames + 1);
              }}
              onSelectionRendered={(key) => {
                setSelectionFrame(key);
              }}
              overlay={
                <div className="absolute top-2 left-2 flex gap-2 font-mono text-[11px]">
                  <span className="border-border bg-background/85 rounded-none border px-2 py-1">
                    {`${toolsApi.activeToolId ?? "none"} · ${toolsApi.phase}`}
                  </span>
                  <span className="border-border bg-background/85 rounded-none border px-2 py-1">
                    {`${selectionApi.selected.length} selected`}
                  </span>
                </div>
              }
            />
          </div>
        </div>
        <div className="flex w-72 shrink-0 flex-col gap-4">
          <CadModelTree
            regenerationStates={regenerationStates}
            className="w-72"
          />
          <CadParameterPanel className="w-72" />
          <Button
            variant="outline"
            size="xs"
            disabled={selectionApi.selected.length === 0}
            onClick={() => {
              selectionApi.clear();
            }}
          >
            Clear selection
          </Button>
        </div>
        <ul className="space-y-1 font-mono text-xs">
          <li>
            build ={" "}
            <span data-testid="plate-build-status">
              {buildError === null ? "ok" : "failed"}
            </span>
          </li>
          <li>
            frames ={" "}
            <span data-testid="plate-settled-frames">
              {String(settledFrames)}
            </span>
          </li>
          <li>
            selection ={" "}
            <span data-testid="plate-selection-key">{selectionKey}</span>
          </li>
          <li>
            selection frame ={" "}
            <span data-testid="plate-selection-frame">{selectionFrame}</span>
          </li>
          <li className="text-destructive">
            <span data-testid="plate-build-error">{buildError ?? ""}</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
