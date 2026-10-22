/**
 * The complete workbench's NON-MODAL topology pick surface (fillet,
 * chamfer, shell and the local face ops) — the chain workbench's pick
 * gesture on the fluid viewport:
 *
 *  - {@link CadTopologyPickOverlay}: every offered target's pickable
 *    entities projected through the scene camera into CSS-pixel anchors
 *    (`./topology-pick`'s {@link topologyTargetAnchorsOf}), drawn as
 *    markers over the canvas and published as `data-topology-anchors`
 *    (`{ [bodyId]: { [ordinal]: [x, y] } }`) beside `data-topology-picks`.
 *    The overlay never takes the pointer: the viewport's own pointer
 *    handler picks the nearest anchor (`nearestTopologyAnchor`), so orbit
 *    and pick share the canvas exactly as on the chain page.
 *  - {@link CadTopologyPickPanel}: the floating panel beside the canvas —
 *    the verb's title and hint, the honest topology-query states, the
 *    current picks, and the verb's Formedible form for the size or the
 *    face operation (mounted once a target is picked).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, RefObject } from "react";
import type { RenderCamera } from "@slopcad/cad-core";
import { Button } from "@slopcad/ui/components/button";

import {
  CAD_FEATURE_FORM_LABELS,
  FaceOpFeatureForm,
  faceOpFormHint,
  faceOpFormTitle,
  TopologyCutFeatureForm,
  topologyCutFormHint,
  topologyCutFormTitle,
  type CadFeatureDatumOption,
  type CadTopologyPickSelection,
  type CadTopologyPickTargetOption,
} from "./feature-forms";
import { isFaceOpKind, type FaceOpSubmission } from "./face-op-pick";
import {
  topologyPickOptionsOf,
  topologyTargetAnchorsOf,
  type TopologyCutSubmission,
  type TopologyPicks,
  type TopologyPickVerb,
} from "./topology-pick";

/**
 * The live CSS-pixel size of the element `ref` points at (`null` until
 * first measured, or where `ResizeObserver` is absent).
 */
function useElementFrame(): {
  readonly ref: RefObject<SVGSVGElement | null>;
  readonly frame: { readonly width: number; readonly height: number } | null;
} {
  const ref = useRef<SVGSVGElement | null>(null);
  const [frame, setFrame] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = element;
      if (clientWidth > 0 && clientHeight > 0) {
        setFrame({ width: clientWidth, height: clientHeight });
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  return { ref, frame };
}

/**
 * The viewport markers of the pickable anchors: picked anchors filled,
 * the rest outlined. Pointer-transparent — the viewport's pointer handler
 * does the picking from the same anchor set.
 */
export function CadTopologyPickOverlay({
  camera,
  picks,
  targets,
  verb,
}: {
  readonly camera: RenderCamera;
  readonly picks: TopologyPicks | null;
  readonly targets: readonly CadTopologyPickTargetOption[];
  readonly verb: TopologyPickVerb;
}): ReactElement {
  const { ref, frame } = useElementFrame();
  const anchors = useMemo(
    () =>
      frame === null
        ? []
        : topologyTargetAnchorsOf(targets, verb, { camera, ...frame }),
    [camera, frame, targets, verb],
  );
  const published = useMemo(() => {
    const byBody: Record<
      string,
      Record<string, readonly [number, number]>
    > = {};
    for (const anchor of anchors) {
      const body = (byBody[anchor.bodyId] ??= {});
      body[String(anchor.ordinal)] = anchor.point;
    }
    return JSON.stringify(byBody);
  }, [anchors]);
  const width = frame?.width ?? 1;
  const height = frame?.height ?? 1;
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-testid="workbench-topology-pick-overlay"
      data-topology-anchors={published}
      data-topology-picks={picks === null ? "" : JSON.stringify(picks)}
      ref={ref}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
    >
      {anchors.map((anchor) => {
        const picked =
          picks !== null &&
          picks.bodyId === anchor.bodyId &&
          picks.ordinals.includes(anchor.ordinal);
        return (
          <circle
            className={
              picked
                ? "fill-primary stroke-background"
                : "fill-background/70 stroke-primary"
            }
            cx={anchor.point[0]}
            cy={anchor.point[1]}
            key={`${anchor.bodyId}:${String(anchor.ordinal)}`}
            r={picked ? 6 : 4}
            strokeWidth={1.5}
          />
        );
      })}
    </svg>
  );
}

/**
 * The floating pick panel: the verb's heading and hint, the topology
 * query's honest states (failed, loading, nothing pickable), the current
 * picks, the verb's form once a target is picked, the structured refusal
 * of the last submission, and Cancel.
 */
export function CadTopologyPickPanel({
  datumPlanes,
  error,
  onCancel,
  onFaceOp,
  onTopologyCut,
  queryError,
  selection,
  targets,
  verb,
}: {
  readonly datumPlanes: readonly CadFeatureDatumOption[];
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onFaceOp: (submission: FaceOpSubmission) => void;
  readonly onTopologyCut: (submission: TopologyCutSubmission) => void;
  readonly queryError: string | null;
  readonly selection: CadTopologyPickSelection | null;
  readonly targets: readonly CadTopologyPickTargetOption[] | null;
  readonly verb: TopologyPickVerb;
}): ReactElement {
  const labels = CAD_FEATURE_FORM_LABELS;
  const faceOp = isFaceOpKind(verb);
  const title = faceOp ? faceOpFormTitle(verb) : topologyCutFormTitle(verb);
  const hint = faceOp ? faceOpFormHint(verb) : topologyCutFormHint(verb);
  const section = faceOp
    ? labels.faceOpFace
    : verb === "shell"
      ? labels.shellFacesSection
      : labels.topologyCutEdgesSection;
  const pickedLabels =
    selection === null
      ? []
      : topologyPickOptionsOf(selection.target.snapshot, verb).filter(
          (option) => selection.ordinals.includes(option.ordinal),
        );
  return (
    <section
      aria-label={title}
      className="pointer-events-auto absolute top-2 left-2 flex max-h-[calc(100%-1rem)] w-80 flex-col gap-(--gap-group) overflow-y-auto rounded-md border border-rule-strong bg-overlay p-3 text-ui shadow-overlay"
      data-testid="workbench-topology-pick-panel"
      data-topology-pick-verb={verb}
    >
      <h2 className="text-title text-ink">{title}</h2>
      <p className="text-label text-ink-dim">{hint}</p>
      {queryError !== null ? (
        <p
          className="text-label text-destructive"
          data-testid="workbench-topology-pick-failed"
          role="alert"
        >
          Reading the visible scene&apos;s topology failed: {queryError}
        </p>
      ) : targets === null ? (
        <p
          className="text-label text-ink-dim"
          data-testid="workbench-topology-pick-loading"
          role="status"
        >
          Reading the visible scene&apos;s topology…
        </p>
      ) : targets.length === 0 ? (
        <p
          className="text-label text-destructive"
          data-testid="workbench-topology-pick-unavailable"
          role="alert"
        >
          No visible body exposes persistent topology to pick. Fillet, chamfer,
          shell and the face ops need the OCCT kernel and a settled, computed
          body.
        </p>
      ) : (
        <>
          <p className="text-ui text-ink-dim">
            {labels.topologyPickInstruction}
          </p>
          <div data-testid="workbench-topology-picks" role="status">
            <p className="text-ui font-medium text-ink">
              {selection === null
                ? section
                : `${section} — ${labels.topologyPickTarget}: ${selection.target.name}`}
            </p>
            {pickedLabels.length === 0 ? (
              <p className="text-label text-ink-dim">
                {labels.topologyPickNone}
              </p>
            ) : (
              <ul className="font-mono text-data text-ink-dim">
                {pickedLabels.map((option) => (
                  <li key={option.ordinal}>{option.label}</li>
                ))}
              </ul>
            )}
          </div>
          {selection === null ? null : faceOp ? (
            <FaceOpFeatureForm
              datumPlanes={datumPlanes}
              key={verb}
              kind={verb}
              onFaceOp={onFaceOp}
              pick={selection}
            />
          ) : (
            <TopologyCutFeatureForm
              key={verb}
              kind={verb}
              onTopologyCut={onTopologyCut}
              pick={selection}
            />
          )}
        </>
      )}
      {error === null ? null : (
        <div
          className="text-destructive border-destructive/40 rounded-sm border px-2 py-1.5 text-xs leading-4"
          data-testid="feature-form-error"
          role="alert"
        >
          {error}
        </div>
      )}
      <Button onClick={onCancel} size="sm" type="button" variant="outline">
        {labels.topologyPickCancel}
      </Button>
    </section>
  );
}
