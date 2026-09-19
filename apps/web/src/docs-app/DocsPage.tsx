/**
 * The /docs documentation application page (Phase 34): the documentation
 * index — every documented topic with its guide's repository path, the
 * kernel capability matrix generated from the kernels' own declared
 * flags, the format-history table (what preserves parametric history and
 * what does not), and the LIVE browser examples imported from
 * `@slopcad/docs-examples` (the same code the workspace gates prove),
 * including a real Manifold-rendered viewport. The page follows the
 * repo's fixture conventions: deterministic, testable, no network.
 */

import { useMemo, useState } from "react";
import type { KernelCapabilities } from "@slopcad/cad-kernel";
import {
  KERNEL_CAPABILITY_ROWS,
  runProjectionExample,
} from "@slopcad/docs-examples";
import { Badge } from "@slopcad/ui/components/badge";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";

import { FORMAT_ROWS } from "./format-history";
import {
  ComponentsExampleCard,
  DocumentExampleCard,
  FeaturesExampleCard,
  KernelExampleCard,
  MeshExampleCard,
  NativeFormatExampleCard,
  ReactExampleCard,
  SketchExampleCard,
} from "./live-examples";
import { DOCS_GROUPS } from "./topics";

/** The capability flags, in declaration order, with honest labels. */
const CAPABILITY_COLUMNS: readonly {
  readonly flag: keyof KernelCapabilities;
  readonly label: string;
}[] = [
  { flag: "booleans", label: "booleans" },
  { flag: "transformTranslation", label: "translate" },
  { flag: "transformRotation", label: "rotate" },
  { flag: "exactPrimitiveVolumes", label: "exact primitive vol." },
  { flag: "exactBooleanVolumes", label: "exact boolean vol." },
  { flag: "tightBooleanBounds", label: "tight boolean bounds" },
  { flag: "persistentTopology", label: "persistent topology" },
  { flag: "sweep", label: "sweep" },
  { flag: "loft", label: "loft" },
  { flag: "fillet", label: "fillet" },
  { flag: "chamfer", label: "chamfer" },
  { flag: "shell", label: "shell" },
  { flag: "mirror", label: "mirror" },
  { flag: "surfaceArea", label: "surface area" },
];

function Section({
  id,
  title,
  lead,
  children,
}: {
  id: string;
  title: string;
  lead?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section id={id} className="scroll-mt-20 border-t pt-10">
      <h2 className="text-lg font-medium tracking-tight">{title}</h2>
      {lead !== undefined ? (
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
          {lead}
        </p>
      ) : null}
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** The render-proof viewport: the projection example, rendered. */
function RenderProofCard(): React.JSX.Element {
  const projection = useMemo(() => {
    try {
      return runProjectionExample().projection;
    } catch {
      return null;
    }
  }, []);
  const [settled, setSettled] = useState(false);
  return (
    <article className="rounded-lg border bg-card">
      <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-medium">
            Render proof — the projected plate, live
          </h3>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            packages/docs-examples/src/core/projection.ts → @slopcad/ui
            CadViewport
          </p>
        </div>
        <p
          className="shrink-0 font-mono text-[11px]"
          data-testid="docs-render-status"
        >
          {settled ? "settled" : "rendering…"}
        </p>
      </header>
      <div className="p-4">
        <CadViewport
          projection={projection}
          className="h-[320px] w-full"
          onSettled={() => {
            setSettled(true);
          }}
        />
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          The same kernel-neutral projection data the GLB exporter consumes,
          drawn by the registry's own CAD viewport component — geometry, camera,
          and lights from the deterministic scene, no host state.
        </p>
        <p className="sr-only" data-testid="docs-render-settled">
          {settled ? "settled" : "pending"}
        </p>
      </div>
    </article>
  );
}

/** The page. */
export function DocsPage(): React.JSX.Element {
  const topicCount = useMemo(
    () => DOCS_GROUPS.reduce((sum, group) => sum + group.topics.length, 0),
    [],
  );
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-6">
          <p className="font-medium tracking-tight">
            slopcad{" "}
            <span className="font-mono text-muted-foreground">/docs</span>
          </p>
          <div className="hidden items-center gap-2 sm:flex">
            <Badge variant="secondary">{String(topicCount)} topics</Badge>
            <Badge variant="secondary">verify-gated examples</Badge>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-6 py-10 lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav
          aria-label="Documentation topics"
          className="hidden self-start pb-10 text-sm lg:sticky lg:top-20 lg:block"
        >
          <ol className="space-y-6">
            {DOCS_GROUPS.map((group) => (
              <li key={group.id}>
                <a
                  href={`#group-${group.id}`}
                  className="block font-mono text-[11px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
                >
                  {group.title}
                </a>
                <ul className="mt-2 space-y-1">
                  {group.topics.map((topic) => (
                    <li key={topic.id}>
                      <a
                        href={`#topic-${topic.id}`}
                        className="block text-[13px] text-muted-foreground hover:text-foreground"
                      >
                        {topic.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </nav>
        <main className="min-w-0 space-y-10">
          <section>
            <h1 className="text-2xl font-medium tracking-tight">
              The slopcad documentation
            </h1>
            <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
              Every guide lives in the repository under{" "}
              <code className="font-mono text-xs">docs/guides/</code>, and every
              primary public API gets a runnable example under{" "}
              <code className="font-mono text-xs">packages/docs-examples/</code>{" "}
              that the workspace gates typecheck, build, and run —{" "}
              <code className="font-mono text-xs">pnpm verify</code> proves
              them, this page proves them again in your browser. The tables
              below are generated from the same source constants the code
              declares, not hand-maintained copies.
            </p>
          </section>

          <Section
            id="examples"
            title="Live examples"
            lead="Browser-runnable, measured. The async cards boot the real Manifold WASM kernel in-process; the numbers are the kernel's own measurements."
          >
            <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-2">
              <DocumentExampleCard />
              <RenderProofCard />
              <KernelExampleCard />
              <FeaturesExampleCard />
              <ComponentsExampleCard />
              <NativeFormatExampleCard />
              <MeshExampleCard />
              <SketchExampleCard />
              <ReactExampleCard />
            </div>
          </Section>

          <Section
            id="kernels"
            title="Kernel capability matrix"
            lead="What each backend declares it can do, read from the kernels' own capability constants (packages/docs-examples/src/kernel/capabilities.ts). A declined operation answers the structured kernel/unsupported-operation — never a silently wrong result."
          >
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <caption className="sr-only">
                  Declared capabilities of the four geometry kernel backends
                </caption>
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      capability
                    </th>
                    {KERNEL_CAPABILITY_ROWS.map((row) => (
                      <th
                        scope="col"
                        key={row.backendId}
                        className="px-3 py-2 text-center font-mono text-xs font-medium"
                      >
                        {row.backendId}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CAPABILITY_COLUMNS.map((column) => (
                    <tr
                      key={column.flag}
                      className="border-b odd:bg-muted/20 last:border-0"
                    >
                      <th
                        scope="row"
                        className="px-3 py-1.5 text-left text-xs font-normal text-muted-foreground"
                      >
                        {column.label}
                      </th>
                      {KERNEL_CAPABILITY_ROWS.map((row) => {
                        const supported = row.capabilities[column.flag];
                        return (
                          <td
                            key={row.backendId}
                            className="px-3 py-1.5 text-center font-mono text-xs"
                            data-flag={`${row.backendId}:${column.flag}`}
                          >
                            <span
                              aria-hidden="true"
                              className={
                                supported
                                  ? "text-foreground"
                                  : "text-muted-foreground/40"
                              }
                            >
                              {supported ? "✓" : "—"}
                            </span>
                            <span className="sr-only">
                              {supported ? "supported" : "not supported"}
                            </span>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              ✓ declared · — declined (answers kernel/unsupported-operation)
            </p>
          </Section>

          <Section
            id="formats"
            title="Formats and parametric history"
            lead="One format preserves the parametric model. Everything else is geometry exchange — deliberate, provenance-marked, and never a fake history."
          >
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <caption className="sr-only">
                  Which exchange formats preserve parametric history
                </caption>
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      format
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      direction
                    </th>
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      what a file carries
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-center font-medium"
                    >
                      parametric history
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {FORMAT_ROWS.map((row) => (
                    <tr
                      key={row.format}
                      className="border-b odd:bg-muted/20 last:border-0"
                    >
                      <th
                        scope="row"
                        className="px-3 py-2 text-left font-mono text-xs font-normal"
                      >
                        {row.format}
                      </th>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.direction}
                      </td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">
                        {row.carries}
                      </td>
                      <td className="px-3 py-2 text-center font-mono text-xs">
                        <span
                          data-testid={`docs-format-${row.format.split(" ")[0]?.toLowerCase()}`}
                        >
                          {row.history ? "preserved" : "—"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          {DOCS_GROUPS.map((group) => (
            <Section
              key={group.id}
              id={`group-${group.id}`}
              title={group.title}
            >
              <ul className="divide-y rounded-lg border">
                {group.topics.map((topic) => (
                  <li
                    key={topic.id}
                    id={`topic-${topic.id}`}
                    className="scroll-mt-20 px-4 py-3"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <h3 className="text-sm font-medium">{topic.title}</h3>
                      <code className="font-mono text-[11px] text-muted-foreground">
                        {topic.guide}
                      </code>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {topic.summary}
                    </p>
                    {topic.example !== null ? (
                      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
                        example: {topic.example}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Section>
          ))}
        </main>
      </div>
    </div>
  );
}
