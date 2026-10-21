import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
// Deep import, deliberately: the docs-examples index also re-exports the
// mesh-exchange example whose cad-io dependency is Node-targeted
// (`node:zlib`) — the same rule the docs page and the /io fixture follow.
import { runProjectionExample } from "@slopcad/docs-examples/core/projection";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import { Panel, PanelHeader } from "@slopcad/ui/components/cockpit/panel";
import { Readout } from "@slopcad/ui/components/cockpit/property-row";

import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

/**
 * The front door.
 *
 * The product is an instrument, so the front door is built like one: the
 * claim, a REAL render of the guide plate (the registry's own viewport
 * over the deterministic projection — the actual renderer, in the
 * visitor's own scheme), and then the surfaces as an INDEX — dense rows
 * with their destinations, not three equal marketing cards. Every value
 * on this page comes from the cockpit tokens; the accent appears exactly
 * once, on the one confirming action ("Open the workbench").
 */

/** The primary surfaces of the app, as the home page's index. */
const SURFACES = [
  {
    to: "/workbench-complete",
    title: "Workbench",
    meta: "the cockpit",
    body: "The full cockpit: toolbar, command palette, model tree, properties, timeline, and the live kernel viewport.",
  },
  {
    to: "/components/$componentId",
    params: { componentId: "nema17-mount" } as const,
    title: "Components",
    meta: "parametric parts",
    body: "Reusable parametric parts, rebuilt live by the Manifold kernel with their analytic proofs.",
  },
  {
    to: "/docs",
    title: "Docs",
    meta: "the manual",
    body: "Every guide and capability, generated from the source constants the gates prove.",
  },
  {
    to: "/viewer",
    title: "Viewer",
    meta: "shared parts",
    body: "Open a shared part and re-drive its variables — the whole document travels in the link.",
  },
] as const;

function HomeComponent() {
  const trpc = useTRPC();
  const healthCheck = useQuery(trpc.healthCheck.queryOptions());
  // A REAL render on the front door: the same deterministic projection the
  // docs page proves, drawn by the registry's own viewport component — the
  // product's actual renderer, in the visitor's own scheme and register.
  const projection = useMemo(() => {
    try {
      return runProjectionExample().projection;
    } catch {
      return null;
    }
  }, []);

  const apiState = healthCheck.isPending
    ? "checking"
    : healthCheck.data
      ? "connected"
      : "disconnected";

  return (
    <div className="h-full overflow-y-auto bg-chrome">
      <main className="mx-auto max-w-[1180px] px-6 py-12">
        {/* The hero: the claim on the left, the proof on the right. The
            render is the only large element on the page. */}
        <section className="grid items-start gap-(--gap-group) lg:grid-cols-[minmax(0,1fr)_minmax(0,600px)] lg:gap-10">
          <div>
            <h1 className="font-display max-w-2xl text-3xl leading-[1.15] font-semibold tracking-tight text-balance text-ink">
              Parametric CAD with a document that tells the truth.
            </h1>
            <p className="mt-4 max-w-xl text-body text-ink-dim">
              Kernel-neutral geometry, real feature history, and reusable
              components, proven by the same workspace gates that build them.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-(--gap)">
              <Link
                className="inline-flex h-8 items-center rounded-sm bg-primary px-3 text-ui font-medium text-primary-foreground transition-colors duration-(--dur-state) ease-(--ease-instrument) hover:bg-primary/85 focus-instrument"
                to="/workbench-complete"
              >
                Open the workbench
              </Link>
              <Link
                className="inline-flex h-8 items-center rounded-sm border border-rule-strong px-3 text-ui font-medium text-ink transition-colors duration-(--dur-state) ease-(--ease-instrument) hover:bg-well focus-instrument"
                to="/docs"
              >
                Read the docs
              </Link>
            </div>
            {/* The live facts of the running instance, as readouts. */}
            <dl className="mt-8 flex flex-wrap items-center gap-x-(--gap-group) gap-y-2 border-t border-rule pt-3">
              {/* The running instance's own health, as a lamp plus its
                  word — the status is never carried by the hue alone. */}
              <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                <dt className="sr-only">api</dt>
                <dd className="flex items-center gap-1.5 font-mono text-data text-ink-dim tabular">
                  <span
                    aria-hidden="true"
                    className={`size-1.5 rounded-full ${
                      healthCheck.isPending
                        ? "bg-signal motion-safe:animate-pulse"
                        : healthCheck.data
                          ? "bg-status-ok"
                          : "bg-destructive"
                    }`}
                  />
                  <span>{`api: ${apiState}`}</span>
                </dd>
              </div>
              <Readout label="kernels">4</Readout>
              <Readout label="exchange">6 formats</Readout>
              <Readout label="history">native only</Readout>
            </dl>
          </div>
          <Panel elevation="panel" className="overflow-hidden">
            <PanelHeader
              title="Guide plate"
              trailing="deterministic projection"
            />
            <div className="bg-viewport">
              <CadViewport
                cameraControls
                className="h-[340px] w-full"
                projection={projection}
              />
            </div>
            <p className="border-t border-rule px-(--pad-panel) py-1.5 font-mono text-micro text-ink-faint">
              rendered live by the deterministic scene — drag to orbit, scroll
              to zoom
            </p>
          </Panel>
        </section>

        {/* The surface index: rows, not cards. */}
        <Panel className="mt-10">
          <PanelHeader
            title="Surfaces"
            titleAs="h2"
            trailing={String(SURFACES.length)}
          />
          <div>
            {SURFACES.map((surface) => (
              <Link
                key={surface.title}
                className="group grid grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto] items-baseline gap-(--gap-group) border-b border-rule/60 px-(--pad-panel) py-2.5 transition-colors duration-(--dur-state) ease-(--ease-instrument) last:border-b-0 hover:bg-well focus-instrument"
                params={"params" in surface ? surface.params : undefined}
                to={surface.to}
              >
                <span className="flex items-baseline gap-2">
                  <span className="font-display text-ui font-semibold text-ink">
                    {surface.title}
                  </span>
                  <span className="whitespace-nowrap font-mono text-micro text-ink-faint">
                    {surface.meta}
                  </span>
                </span>
                <span className="text-ui text-ink-dim">{surface.body}</span>
                <span className="font-mono text-micro text-ink-faint transition-colors duration-(--dur-state) group-hover:text-ink-dim">
                  {surface.to.replace("/$componentId", "")}
                </span>
              </Link>
            ))}
          </div>
        </Panel>
      </main>
    </div>
  );
}
