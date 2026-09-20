import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";
// Deep import, deliberately: the docs-examples index also re-exports the
// mesh-exchange example whose cad-io dependency is Node-targeted
// (`node:zlib`) — the same rule the docs page and the /io fixture follow.
import { runProjectionExample } from "@slopcad/docs-examples/core/projection";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";

import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

/** The primary surfaces of the app, as the home page's index. */
const SURFACES = [
  {
    to: "/workbench-complete",
    title: "Workbench",
    body: "The full cockpit: toolbar, command palette, model tree, properties, timeline, and the live kernel viewport.",
  },
  {
    to: "/components/$componentId",
    params: { componentId: "nema17-mount" } as const,
    title: "Components",
    body: "Reusable parametric parts, rebuilt live by the Manifold kernel with their analytic proofs.",
  },
  {
    to: "/docs",
    title: "Docs",
    body: "Every guide and capability, generated from the source constants the gates prove.",
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

  return (
    <div className="bg-background/30 h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-16">
        {/* The hero: the claim, then the proof — the guide plate rendered
            live by the deterministic scene, under the same registration
            brackets the workbench stage wears. */}
        <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
          <div>
            <div className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="border-primary/70 bg-primary/15 relative size-4 rounded-[4px] border"
              >
                <span className="border-primary absolute -top-1 -left-1 size-2 rounded-[2px] border" />
              </span>
              <p className="text-foreground font-mono text-sm font-semibold tracking-tight">
                slopcad
              </p>
            </div>
            <h1 className="font-display mt-8 max-w-2xl text-4xl leading-tight font-semibold tracking-tight text-balance">
              Parametric CAD with a document that tells the truth.
            </h1>
            <p className="text-muted-foreground mt-4 max-w-xl text-sm leading-relaxed">
              Kernel-neutral geometry, real feature history, and reusable
              components, proven by the same workspace gates that build them.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                className="bg-primary text-primary-foreground hover:bg-primary/85 inline-flex h-9 items-center rounded-sm px-4 text-sm font-medium transition-colors"
                to="/workbench-complete"
              >
                Open the workbench
              </Link>
              <Link
                className="border-border bg-card hover:bg-muted inline-flex h-9 items-center rounded-sm border px-4 text-sm font-medium transition-colors"
                to="/docs"
              >
                Read the docs
              </Link>
              <span className="text-muted-foreground ml-1 inline-flex items-center gap-2 font-mono text-[11px]">
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
                {healthCheck.isPending
                  ? "api: checking"
                  : healthCheck.data
                    ? "api: connected"
                    : "api: disconnected"}
              </span>
            </div>
          </div>
          <div className="border-border bg-card rounded-lg border p-2">
            <CadViewport
              cameraControls
              className="h-[340px] w-full"
              projection={projection}
            />
            <p className="text-muted-foreground px-1 pt-1.5 pb-0.5 font-mono text-[11px]">
              the guide plate, rendered live by the deterministic scene — drag
              to orbit, scroll to zoom
            </p>
          </div>
        </section>

        <div className="mt-14 grid gap-3 sm:grid-cols-3">
          {SURFACES.map((surface) => (
            <Link
              key={surface.title}
              className="border-border bg-card/60 group hover:border-input hover:bg-card rounded-lg border p-4 transition-colors"
              params={"params" in surface ? surface.params : undefined}
              to={surface.to}
            >
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="font-display text-sm font-semibold">
                  {surface.title}
                </h2>
                <span
                  aria-hidden="true"
                  className="text-muted-foreground group-hover:text-foreground font-mono text-xs transition-colors"
                >
                  →
                </span>
              </div>
              <p className="text-muted-foreground mt-2 text-xs leading-relaxed">
                {surface.body}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
