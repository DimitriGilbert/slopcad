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

import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KernelCapabilities } from "@slopcad/cad-kernel";
import {
  KERNEL_CAPABILITY_ROWS,
  runProjectionExample,
} from "@slopcad/docs-examples";
import { Badge } from "@slopcad/ui/components/badge";
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";

import UserMenu from "../components/user-menu";
import { SchemePicker } from "../components/scheme-picker";
import { ThemeToggle } from "../components/theme-toggle";
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

/** The section rail's ordered anchors (the sticky header's jump links). */
const SECTION_LINKS: readonly {
  readonly id: string;
  readonly label: string;
}[] = [
  { id: "examples", label: "Examples" },
  { id: "kernels", label: "Kernels" },
  { id: "formats", label: "Formats" },
  { id: `group-${DOCS_GROUPS[0]?.id ?? "guides"}`, label: "Guides" },
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
    <section id={id} className="border-t pt-10">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
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
    <article className="border-border bg-card/60 overflow-hidden rounded-lg border">
      <header className="border-border bg-background/40 flex items-start justify-between gap-3 border-b px-4 py-3">
        <div>
          <h3 className="text-sm font-medium">
            Render proof: the projected plate, live
          </h3>
          <p className="text-muted-foreground mt-0.5 font-mono text-[11px]">
            packages/docs-examples/src/core/projection.ts → @slopcad/ui
            CadViewport
          </p>
        </div>
        <p
          className="text-muted-foreground shrink-0 font-mono text-[11px]"
          data-testid="docs-render-status"
        >
          {settled ? "settled" : "rendering…"}
        </p>
      </header>
      <div className="p-4">
        <div className="border-border/80 bg-background/50 rounded-lg border p-1">
          <div className="overflow-hidden rounded-[6px]">
            <CadViewport
              projection={projection}
              className="h-[320px] w-full"
              onSettled={() => {
                setSettled(true);
              }}
            />
          </div>
        </div>
        <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
          The same kernel-neutral projection data the GLB exporter consumes,
          drawn by the registry's own CAD viewport component: geometry, camera,
          and lights from the deterministic scene, no host state.
        </p>
        <p className="sr-only" data-testid="docs-render-settled">
          {settled ? "settled" : "pending"}
        </p>
      </div>
    </article>
  );
}

/**
 * The topic rail: the page's groups as one sticky index. The active
 * group is tracked with an IntersectionObserver (no scroll listeners),
 * purely visual — every link stays a plain anchor.
 */
function TopicRail(): React.JSX.Element {
  const [active, setActive] = useState<string | null>(null);
  const rootRef = useRef<HTMLOListElement | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const anchors = Array.from(
      root.querySelectorAll<HTMLAnchorElement>("a[href^='#group-']"),
    );
    const sections = anchors
      .map((anchor) => document.querySelector(anchor.hash))
      .filter((section): section is Element => section !== null);
    if (sections.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // The topmost intersecting section wins the rail highlight.
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0]?.target.id;
        if (first !== undefined) setActive(first);
      },
      { rootMargin: "-15% 0px -70% 0px", threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <nav
      aria-label="Documentation topics"
      className="hidden self-start pb-10 text-sm lg:sticky lg:top-6 lg:block"
    >
      <ol className="space-y-7" ref={rootRef}>
        {DOCS_GROUPS.map((group) => {
          const groupActive = active === `group-${group.id}`;
          return (
            <li key={group.id}>
              <a
                href={`#group-${group.id}`}
                className={`block font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase transition-colors ${
                  groupActive
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {group.title}
              </a>
              <ul className="mt-2 space-y-0.5 border-l pl-3">
                {group.topics.map((topic) => {
                  const topicActive = active === `topic-${topic.id}`;
                  return (
                    <li key={topic.id}>
                      <a
                        href={`#topic-${topic.id}`}
                        className={`-ml-px block border-l py-0.5 pl-3 text-[13px] transition-colors ${
                          topicActive
                            ? "border-primary text-primary"
                            : "border-transparent text-muted-foreground hover:border-border hover:text-foreground"
                        }`}
                      >
                        {topic.title}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
    </nav>
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
      <header className="border-border bg-background/90 sticky top-0 z-10 border-b backdrop-blur-sm">
        <div className="mx-auto flex h-12 max-w-6xl items-center gap-6 px-6">
          <Link
            className="flex items-center gap-2 font-mono text-sm font-semibold tracking-tight"
            title="slopcad home"
            to="/"
          >
            <span
              aria-hidden="true"
              className="border-primary/70 bg-primary/15 relative size-3 rounded-[3px] border"
            >
              <span className="border-primary absolute -top-[3px] -left-[3px] size-1.5 rounded-[2px] border" />
            </span>
            slopcad <span className="text-muted-foreground">/docs</span>
          </Link>
          <nav aria-label="Sections" className="hidden gap-1 sm:flex">
            {SECTION_LINKS.map((link) => (
              <a
                key={link.id}
                href={`#${link.id}`}
                className="text-muted-foreground hover:text-foreground hover:bg-muted rounded-sm px-2.5 py-1 text-[13px] font-medium transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <SchemePicker />
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-6xl grid-cols-1 gap-10 px-6 py-10 lg:grid-cols-[210px_minmax(0,1fr)]">
        <TopicRail />
        <main className="min-w-0 space-y-10">
          <section className="border-t-0 pt-0">
            <p className="text-muted-foreground font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
              Documentation
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">
              The slopcad documentation
            </h1>
            <p className="text-muted-foreground mt-3 max-w-prose text-sm leading-relaxed">
              Every guide lives in the repository under{" "}
              <code className="border-border bg-muted/60 rounded-[3px] border px-1 py-px font-mono text-xs">
                docs/guides/
              </code>
              , and every primary public API gets a runnable example under{" "}
              <code className="border-border bg-muted/60 rounded-[3px] border px-1 py-px font-mono text-xs">
                packages/docs-examples/
              </code>{" "}
              that the workspace gates typecheck, build, and run.{" "}
              <code className="border-border bg-muted/60 rounded-[3px] border px-1 py-px font-mono text-xs">
                pnpm verify
              </code>{" "}
              proves them, this page proves them again in your browser. The
              tables below are generated from the same source constants the code
              declares, not hand-maintained copies.
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Badge variant="secondary">{String(topicCount)} topics</Badge>
              <Badge variant="secondary">verify-gated examples</Badge>
            </div>
          </section>

          <Section
            id="examples"
            title="Live examples"
            lead="Browser-runnable, measured. The async cards boot the real Manifold WASM kernel in-process, and the numbers are the kernel's own measurements."
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
            lead="What each backend declares it can do, read from the kernels' own capability constants (packages/docs-examples/src/kernel/capabilities.ts). A declined operation answers the structured kernel/unsupported-operation, never a silently wrong result."
          >
            <div className="border-border bg-card/60 overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <caption className="sr-only">
                  Declared capabilities of the four geometry kernel backends
                </caption>
                <thead>
                  <tr className="border-border bg-background/40 border-b">
                    <th scope="col" className="px-3 py-2 text-left font-medium">
                      capability
                    </th>
                    {KERNEL_CAPABILITY_ROWS.map((row) => (
                      <th
                        scope="col"
                        key={row.backendId}
                        className="text-muted-foreground px-3 py-2 text-center font-mono text-xs font-medium"
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
                      className="border-border/70 border-b transition-colors last:border-0 hover:bg-muted/40"
                    >
                      <th
                        scope="row"
                        className="text-muted-foreground px-3 py-1.5 text-left text-xs font-normal"
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
                                  ? "text-primary"
                                  : "text-muted-foreground/50"
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
            <p className="text-muted-foreground mt-2 font-mono text-[11px]">
              ✓ declared · — declined (answers kernel/unsupported-operation)
            </p>
          </Section>

          <Section
            id="formats"
            title="Formats and parametric history"
            lead="One format preserves the parametric model. Everything else is geometry exchange: deliberate, provenance-marked, and never a fake history."
          >
            <div className="border-border bg-card/60 overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[720px] border-collapse text-sm">
                <caption className="sr-only">
                  Which exchange formats preserve parametric history
                </caption>
                <thead>
                  <tr className="border-border bg-background/40 border-b">
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
                      className="border-border/70 border-b transition-colors last:border-0 hover:bg-muted/40"
                    >
                      <th
                        scope="row"
                        className="px-3 py-2 text-left font-mono text-xs font-normal"
                      >
                        {row.format}
                      </th>
                      <td className="text-muted-foreground px-3 py-2 text-xs">
                        {row.direction}
                      </td>
                      <td className="text-muted-foreground px-3 py-2 text-xs">
                        {row.carries}
                      </td>
                      <td className="px-3 py-2 text-center font-mono text-xs">
                        <span
                          className={
                            row.history
                              ? "text-primary font-medium"
                              : "text-muted-foreground/60"
                          }
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
              <ul className="border-border bg-card/60 divide-border/70 overflow-hidden rounded-lg border divide-y">
                {group.topics.map((topic) => (
                  <li
                    key={topic.id}
                    id={`topic-${topic.id}`}
                    className="scroll-mt-20 px-4 py-3 transition-colors hover:bg-muted/40"
                  >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                      <h3 className="text-sm font-medium">{topic.title}</h3>
                      <code className="border-border text-muted-foreground rounded-sm border bg-background/50 px-1.5 py-0.5 font-mono text-[11px]">
                        {topic.guide}
                      </code>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                      {topic.summary}
                    </p>
                    {topic.example !== null ? (
                      <p className="text-muted-foreground mt-1.5 font-mono text-[11px]">
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
