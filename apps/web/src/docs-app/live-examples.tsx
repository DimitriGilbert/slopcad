/**
 * The /docs page's live examples (Phase 34): the browser-runnable
 * documentation examples, imported from `@slopcad/docs-examples` — the
 * SAME code the workspace gates typecheck, build, and run — executed on
 * this page with their measured results rendered. The Manifold-backed
 * examples boot the real WASM kernel in-process (the consumer fixture's
 * `locateFile` pin pattern); everything else is synchronous pure core.
 */

import { useEffect, useMemo, useState } from "react";
import { exportStlBinary } from "@slopcad/cad-io";
import type { GeometryKernel, KernelSolid } from "@slopcad/cad-kernel";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
  type ManifoldRuntime,
} from "@slopcad/cad-kernel-manifold";
import {
  EXAMPLE_TESSELLATION,
  runDocumentExample,
  runKernelExample,
  runMeshExchangeExample,
  runSketchExample,
  runSketchVocabularyExample,
  runUnitsExample,
  unwrapKernel,
} from "@slopcad/docs-examples";
import { runComponentsExample } from "@slopcad/docs-examples/components/components";
import { runFeaturesExample } from "@slopcad/docs-examples/kernel/features";
import { runNativeFormatExample } from "@slopcad/docs-examples/core/native";
import { CadProvider } from "@slopcad/cad-react";
import { Panel, PanelHeader } from "@slopcad/ui/components/cockpit/panel";
import {
  createGuideStore,
  GuideParameterPanel,
} from "@slopcad/docs-examples/react/store";
// Vite asset pin: the dependency optimizer breaks manifold.js's own
// `new URL("manifold.wasm", import.meta.url)` resolution, so the runtime
// receives an explicit `locateFile` (the consumer fixture's pattern).
import wasmUrl from "manifold-3d/manifold.wasm?url";

/** The shared in-process Manifold runtime (one WASM heap per page). */
let runtimePromise: Promise<ManifoldRuntime> | null = null;

function getRuntime(): Promise<ManifoldRuntime> {
  runtimePromise ??= createManifoldRuntime({
    locateFile: () => wasmUrl,
  });
  return runtimePromise;
}

function getKernel(): Promise<GeometryKernel> {
  return getRuntime().then(manifoldKernelFromRuntime);
}

/** One measured fact rendered by an example card. */
export interface Fact {
  readonly label: string;
  readonly value: string;
}

/** The shape every example card renders. */
export interface ExampleCardProps {
  readonly title: string;
  readonly source: string;
  readonly status: "running" | "ok" | "failed";
  readonly facts: readonly Fact[];
  readonly children?: React.ReactNode;
}

function slug(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mm3(value: number): string {
  return `${value.toFixed(2)} mm³`;
}

/** The example card shell: header, status, and the measured facts. */
export function ExampleCard({
  title,
  source,
  status,
  facts,
  children,
}: ExampleCardProps): React.JSX.Element {
  return (
    <Panel
      className="overflow-hidden data-[status=failed]:border-destructive/50"
      data-status={status}
    >
      <PanelHeader
        title={title}
        titleAs="h3"
        trailing={
          <span
            className="flex items-center gap-1.5"
            data-testid="docs-example-status"
          >
            <span
              aria-hidden="true"
              className={`size-1.5 shrink-0 rounded-full ${
                status === "ok"
                  ? "bg-status-ok"
                  : status === "running"
                    ? "bg-signal motion-safe:animate-pulse"
                    : "bg-destructive"
              }`}
            />
            <span className={status === "failed" ? "text-destructive" : ""}>
              {status === "running" ? "running…" : status}
            </span>
          </span>
        }
      />
      <p className="border-b border-rule bg-well/60 px-(--pad-panel) py-1 font-mono text-micro ink-faint">
        {source}
      </p>
      <div className="p-(--pad-panel)">
        {status === "failed" ? (
          <p className="font-mono text-data text-destructive">
            the example failed; see the browser console
          </p>
        ) : (
          /* The measured facts ARE property rows: label left, tabular
             value right, one 24px line each, hairline between. */
          <dl className="grid grid-cols-[minmax(0,1fr)_auto]">
            {facts.map((fact) => (
              <div
                key={fact.label}
                className="col-span-2 grid min-h-(--row-h) grid-cols-subgrid items-center gap-x-(--gap-group) border-b border-rule/60 last:border-b-0"
              >
                <dt className="truncate text-label ink-dim">{fact.label}</dt>
                <dd
                  className="text-right font-mono text-data ink tabular"
                  data-testid={`docs-fact-${slug(fact.label)}`}
                >
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        )}
        {children}
      </div>
    </Panel>
  );
}

/** A card whose facts arrive from a promise over the Manifold kernel. */
function useKernelExample(
  compute: (kernel: GeometryKernel) => readonly Fact[],
): { status: "running" | "ok" | "failed"; facts: readonly Fact[] } {
  const [state, setState] = useState<{
    status: "running" | "ok" | "failed";
    facts: readonly Fact[];
  }>({ status: "running", facts: [] });
  useEffect(() => {
    let cancelled = false;
    getKernel()
      .then((kernel) => {
        if (cancelled) return;
        setState({ status: "ok", facts: compute(kernel) });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed", facts: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [compute]);
  return state;
}

/** The document/parameters/expressions/units example (synchronous). */
export function DocumentExampleCard(): React.JSX.Element {
  const [state] = useState(() => {
    try {
      return {
        status: "ok" as const,
        document: runDocumentExample(),
        units: runUnitsExample(),
      };
    } catch {
      return { status: "failed" as const };
    }
  });
  return (
    <ExampleCard
      title="Document, parameters, expressions, units"
      source="packages/docs-examples/src/core/document.ts, units.ts"
      status={state.status}
      facts={
        state.status === "ok"
          ? [
              {
                label: "holeDiameter",
                value: `${String(state.document.holeDiameterMm)} → ${String(state.document.editedHoleDiameterMm)} mm`,
              },
              {
                label: "volumeHint = holeDiameter × 2",
                value: `${String(state.document.volumeHintMm)} → ${String(state.document.editedVolumeHintMm)}`,
              },
              {
                label: "timeline",
                value: state.document.timelineKinds.join(", "),
              },
              { label: "1 inch", value: `${String(state.units.inchInMm)} mm` },
              {
                label: "2in × 40mm × 5mm",
                value: mm3(state.units.boxVolumeMm3),
              },
            ]
          : []
      }
    />
  );
}

/** The Manifold primitives/booleans example (async, real WASM geometry). */
export function KernelExampleCard(): React.JSX.Element {
  const compute = useMemo(
    () =>
      (kernel: GeometryKernel): readonly Fact[] => {
        const summary = runKernelExample(kernel);
        return [
          { label: "backend", value: summary.backendId },
          { label: "box volume", value: mm3(summary.boxVolumeMm3) },
          {
            label: "box area",
            value: `${summary.boxSurfaceAreaMm2.toFixed(2)} mm²`,
          },
          {
            label: "union (half overlap)",
            value: mm3(summary.unionVolumeMm3),
          },
          {
            label: "box − cylinder",
            value: mm3(summary.subtractVolumeMm3),
          },
          {
            label: "box tessellation",
            value: `${String(summary.boxTriangleCount)} triangles`,
          },
        ];
      },
    [],
  );
  const state = useKernelExample(compute);
  return (
    <ExampleCard
      title="Primitives and booleans: real Manifold geometry"
      source="packages/docs-examples/src/kernel/primitives.ts"
      status={state.status}
      facts={state.facts}
    />
  );
}

/** The feature-regeneration example (async, the core-bridge + Manifold). */
export function FeaturesExampleCard(): React.JSX.Element {
  const compute = useMemo(
    () =>
      (kernel: GeometryKernel): readonly Fact[] => {
        const volumeOf = (solid: KernelSolid): number =>
          unwrapKernel(kernel.volume(solid), "volume");
        const summary = runFeaturesExample(kernel, volumeOf);
        return [
          {
            label: "feature kinds",
            value: summary.featureKinds.join(" → "),
          },
          {
            label: "volume after D8 hole",
            value: mm3(summary.volumeAfterHoleMm3),
          },
          {
            label: "volume after D10 edit",
            value: mm3(summary.volumeAfterEditMm3),
          },
          {
            label: "states after edit",
            value: summary.editedStates.join(", "),
          },
        ];
      },
    [],
  );
  const state = useKernelExample(compute);
  return (
    <ExampleCard
      title="Feature regeneration through the kernel bridge"
      source="packages/docs-examples/src/kernel/features.ts"
      status={state.status}
      facts={state.facts}
    />
  );
}

/** The reusable-components example (async, the shipped NEMA 17 mount). */
export function ComponentsExampleCard(): React.JSX.Element {
  const [state, setState] = useState<{
    status: "running" | "ok" | "failed";
    facts: readonly Fact[];
  }>({ status: "running", facts: [] });
  useEffect(() => {
    let cancelled = false;
    getRuntime()
      .then((runtime) => runComponentsExample(runtime))
      .then((summary) => {
        if (cancelled) return;
        setState({
          status: "ok",
          facts: [
            { label: "bodies built", value: String(summary.nema17Bodies) },
            { label: "nema17 volume", value: mm3(summary.nema17VolumeMm3) },
            {
              label: "plateSizeMm 46 → 52",
              value: mm3(summary.nema17EditedVolumeMm3),
            },
            { label: "ports resolved", value: String(summary.nema17PortCount) },
            {
              label: "custom washer volume",
              value: mm3(summary.washerVolumeMm3),
            },
          ],
        });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "failed", facts: [] });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <ExampleCard
      title="Reusable components: contract + kernel build"
      source="packages/docs-examples/src/components/components.ts"
      status={state.status}
      facts={state.facts}
    />
  );
}

/** The mesh-exchange example with an honest STL download. */
export function MeshExampleCard(): React.JSX.Element {
  const [state] = useState(() => {
    try {
      return { status: "ok" as const, summary: runMeshExchangeExample() };
    } catch {
      return { status: "failed" as const };
    }
  });
  const downloadUrl = useMemo(() => {
    if (state.status !== "ok") return null;
    const exported = exportStlBinary(EXAMPLE_TESSELLATION);
    if (!exported.ok) return null;
    return URL.createObjectURL(
      new Blob([exported.value as BlobPart], { type: "model/stl" }),
    );
  }, [state]);
  useEffect(() => {
    return () => {
      if (downloadUrl !== null) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);
  return (
    <ExampleCard
      title="STL / 3MF / GLB: deterministic bytes"
      source="packages/docs-examples/src/io/mesh.ts"
      status={state.status}
      facts={
        state.status === "ok"
          ? [
              {
                label: "STL bytes (12 triangles)",
                value: String(state.summary.stlBytes),
              },
              {
                label: "STL deterministic",
                value: state.summary.stlDeterministic ? "yes" : "no",
              },
              {
                label: "3MF bytes · unit",
                value: `${String(state.summary.threeMfBytes)} B · ${state.summary.threeMfUnit}`,
              },
              {
                label: "GLB bytes",
                value: `${String(state.summary.glbBytes)} B`,
              },
            ]
          : []
      }
    >
      {downloadUrl !== null ? (
        <a
          className="mt-2 inline-block font-mono text-micro ink-dim underline underline-offset-4 transition-colors duration-(--dur-state) hover:ink focus-instrument"
          href={downloadUrl}
          download="docs-example-plate.stl"
        >
          download the example's plate.stl
        </a>
      ) : null}
    </ExampleCard>
  );
}

/** The sketch/constraints example (synchronous solve). */
export function SketchExampleCard(): React.JSX.Element {
  const [state] = useState(() => {
    try {
      return { status: "ok" as const, summary: runSketchExample() };
    } catch {
      return { status: "failed" as const };
    }
  });
  return (
    <ExampleCard
      title="Sketch solve: degrees of freedom, honestly counted"
      source="packages/docs-examples/src/sketch/sketch.ts"
      status={state.status}
      facts={
        state.status === "ok"
          ? [
              {
                label: "dof before constraints",
                value: String(state.summary.underConstrainedDof),
              },
              {
                label: "dof after",
                value: String(state.summary.solvedDof),
              },
              {
                label: "|AB| solved",
                value: `${state.summary.solvedAbLengthMm.toFixed(6)} mm`,
              },
              {
                label: "profile signed area",
                value: `${state.summary.profileSignedAreaMm2.toFixed(3)} mm²`,
              },
              {
                label: "serialize round trip",
                value: state.summary.serializedRoundTripExact
                  ? "exact"
                  : "differs",
              },
            ]
          : []
      }
    />
  );
}

/** The Phase 36 sketch-vocabulary example (synchronous solve). */
export function SketchVocabularyExampleCard(): React.JSX.Element {
  const [state] = useState(() => {
    try {
      return { status: "ok" as const, summary: runSketchVocabularyExample() };
    } catch {
      return { status: "failed" as const };
    }
  });
  return (
    <ExampleCard
      title="Sketch vocabulary: ellipses, splines, and slots"
      source="packages/docs-examples/src/sketch/vocabulary.ts"
      status={state.status}
      facts={
        state.status === "ok"
          ? [
              {
                label: "ellipse dof bare → constrained",
                value: `${String(state.summary.ellipseDof)} → ${String(state.summary.ellipseConstrainedDof)}`,
              },
              {
                label: "solved semi-axes",
                value: `${state.summary.solvedRadiusXMm.toFixed(6)} × ${state.summary.solvedRadiusYMm.toFixed(6)} mm`,
              },
              {
                label: "spline interior dof (endpoints pinned)",
                value: String(state.summary.splineInteriorDof),
              },
              {
                label: "slot loop area (πr² + 2rL)",
                value: `${state.summary.slotLoopAreaMm2.toFixed(3)} mm²`,
              },
              {
                label: "serialize round trip",
                value: state.summary.serializedRoundTripExact
                  ? "exact"
                  : "differs",
              },
            ]
          : []
      }
    />
  );
}

/** The native-format example (synchronous, full parametric history). */
export function NativeFormatExampleCard(): React.JSX.Element {
  const [state] = useState(() => {
    try {
      return { status: "ok" as const, summary: runNativeFormatExample() };
    } catch {
      return { status: "failed" as const };
    }
  });
  return (
    <ExampleCard
      title="Native format: the one that keeps history"
      source="packages/docs-examples/src/core/native.ts"
      status={state.status}
      facts={
        state.status === "ok"
          ? [
              { label: "text bytes", value: String(state.summary.textBytes) },
              {
                label: "replayed transactions",
                value: String(state.summary.reopenedTransactionCount),
              },
              {
                label: "reopened holeDiameter",
                value: `${String(state.summary.reopenedHoleMm)} mm`,
              },
              {
                label: "resave identical",
                value: state.summary.resaveIdentical ? "yes" : "no",
              },
              {
                label: "validator issues",
                value: String(state.summary.validatorIssues),
              },
            ]
          : []
      }
    />
  );
}

/** The interactive React-integration example, mounted live. */
export function ReactExampleCard(): React.JSX.Element {
  const store = useMemo(() => createGuideStore(), []);
  return (
    <ExampleCard
      title="React integration: live parameter edit"
      source="packages/docs-examples/src/react/store.tsx"
      status="ok"
      facts={[{ label: "interaction", value: "click the button" }]}
    >
      <div className="mt-3 rounded-md border bg-background px-3 py-3">
        <CadProvider store={store}>
          <GuideParameterPanel />
        </CadProvider>
      </div>
    </ExampleCard>
  );
}
