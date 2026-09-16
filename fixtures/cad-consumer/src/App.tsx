/**
 * The consumer's composed CAD usage (Phase 16): the four registry-installed
 * components — CadToolbar, CadViewport, CadModelTree, CadParameterPanel —
 * around one real provider store. The session is the consumer document
 * (parametric plate); the geometry is computed on the main thread through
 * the Manifold kernel and fed to the viewport as a render projection; every
 * parameter edit the panel applies comes back as a new document, a new
 * regeneration pass, and a new projection.
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

import { Button } from "@/components/button";
import { CadModelTree } from "@/components/cad/cad-model-tree";
import { CadParameterPanel } from "@/components/cad/cad-parameter-panel";
import { CadToolbar } from "@/components/cad/cad-toolbar";
import { CadViewport } from "@/components/cad/cad-viewport";
import {
  createConsumerSession,
  holeDiameterMmOf,
  translateComponentsMmOf,
} from "@/cad/consumer-document";
import { buildPlateProjection } from "@/cad/plate-geometry";

/** The provider store, composed once from the consumer's session. */
function useConsumerStore() {
  const [store] = useState(() =>
    createCadStore({
      session: createConsumerSession(),
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

export function App(): ReactElement {
  const store = useConsumerStore();
  return (
    <CadProvider store={store}>
      <ConsumerWorkbench />
    </CadProvider>
  );
}

function ConsumerWorkbench(): ReactElement {
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
    <div id="consumer-root" className="mx-auto w-full max-w-6xl space-y-4 p-6">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold">
          slopcad registry consumer — CAD session
        </h1>
        <p className="text-muted-foreground text-sm">
          The four CAD components installed from the locally generated registry
          artifacts, composed around a real Manifold-kernel session.
        </p>
      </header>
      <div className="flex flex-wrap items-start gap-6">
        <div className="space-y-2">
          <CadToolbar />
          <div id="consumer-viewport" className="relative">
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
            <span id="consumer-build-status" data-testid="build-status">
              {buildError === null ? "ok" : "failed"}
            </span>
          </li>
          <li>
            frames ={" "}
            <span id="consumer-frames" data-testid="settled-frames">
              {String(settledFrames)}
            </span>
          </li>
          <li>
            selection ={" "}
            <span id="consumer-selection" data-testid="selection-key">
              {selectionKey}
            </span>
          </li>
          <li>
            selection frame ={" "}
            <span data-testid="selection-frame">{selectionFrame}</span>
          </li>
          <li className="text-destructive">
            <span id="consumer-error">{buildError ?? ""}</span>
          </li>
        </ul>
      </div>
    </div>
  );
}
