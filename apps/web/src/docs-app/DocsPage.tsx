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
import { CadViewport } from "@slopcad/ui/components/cad/cad-viewport";
import { Panel, PanelHeader } from "@slopcad/ui/components/cockpit/panel";
import { Readout } from "@slopcad/ui/components/cockpit/property-row";

import UserMenu from "../components/user-menu";
import { PlateMark } from "../components/header";
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
  SketchVocabularyExampleCard,
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
    <section id={id} className="border-t border-rule pt-7">
      <h2 className="label-section text-ink">{title}</h2>
      {lead !== undefined ? (
        <p className="mt-2 max-w-[72ch] text-body text-ink-dim">{lead}</p>
      ) : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** A table cell's shared metrics: the manual is a reference, so rows are
 * row-height, hairline-separated, and every value is tabular mono. */
const TABLE_HEAD_CELL = "label-section px-2 py-1.5 text-left text-ink-faint";
const TABLE_ROW =
  "border-b border-rule/60 transition-colors duration-(--dur-state) last:border-b-0 hover:bg-well";

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
    <Panel className="overflow-hidden">
      <PanelHeader
        title="Render proof: the projected plate, live"
        titleAs="h3"
        trailing={
          <span data-testid="docs-render-status">
            {settled ? "settled" : "rendering…"}
          </span>
        }
      />
      <p className="border-b border-rule bg-well/60 px-(--pad-panel) py-1 font-mono text-micro text-ink-faint">
        packages/docs-examples/src/core/projection.ts → @slopcad/ui CadViewport
      </p>
      {/* The render sits on the viewport surface, flush to the panel — the
          bed is a material, not a card inside a card. */}
      <div className="bg-viewport">
        <CadViewport
          projection={projection}
          className="h-[320px] w-full"
          onSettled={() => {
            setSettled(true);
          }}
        />
      </div>
      <p className="border-t border-rule p-(--pad-panel) text-ui text-ink-dim">
        The same kernel-neutral projection data the GLB exporter consumes, drawn
        by the registry&apos;s own CAD viewport component: geometry, camera, and
        lights from the deterministic scene, no host state.
      </p>
      <p className="sr-only" data-testid="docs-render-settled">
        {settled ? "settled" : "pending"}
      </p>
    </Panel>
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
      className="hidden self-start pb-10 lg:sticky lg:top-(--gap-group) lg:block"
    >
      <ol className="space-y-5" ref={rootRef}>
        {DOCS_GROUPS.map((group) => {
          const groupActive = active === `group-${group.id}`;
          return (
            <li key={group.id}>
              <a
                href={`#group-${group.id}`}
                className={`label-section block transition-colors duration-(--dur-state) focus-instrument ${
                  groupActive ? "text-ink" : "text-ink-faint hover:text-ink-dim"
                }`}
              >
                {group.title}
              </a>
              <ul className="mt-1.5 border-l border-rule pl-2.5">
                {group.topics.map((topic) => {
                  const topicActive = active === `topic-${topic.id}`;
                  return (
                    <li key={topic.id}>
                      <a
                        href={`#topic-${topic.id}`}
                        /* The rail's current entry is marked the way
                           selection is marked everywhere: the signal edge
                           and bright ink, never an accent-coloured label. */
                        className={`-ml-px flex min-h-(--row-h) items-center border-l-2 pl-2.5 text-ui transition-colors duration-(--dur-state) focus-instrument ${
                          topicActive
                            ? "border-l-select-edge text-ink"
                            : "border-l-transparent text-ink-dim hover:border-l-rule-strong hover:text-ink"
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
    <div className="min-h-screen bg-chrome text-ink">
      <header className="sticky top-0 z-10 border-b border-rule bg-chrome/95 backdrop-blur-sm">
        <div className="mx-auto flex h-(--appbar-h) max-w-[1180px] items-center gap-(--gap-group) px-6">
          <Link
            className="flex items-center gap-2 focus-instrument"
            title="slopcad home"
            to="/"
          >
            <PlateMark className="size-3 rounded-[3px]" />
            <span className="font-display text-title font-semibold text-ink">
              slopcad
            </span>
            <span className="font-mono text-micro text-ink-faint">/docs</span>
          </Link>
          <nav
            aria-label="Sections"
            className="hidden gap-(--gap-tight) sm:flex"
          >
            {SECTION_LINKS.map((link) => (
              <a
                key={link.id}
                href={`#${link.id}`}
                className="flex h-(--tool-h) items-center rounded-sm px-2 text-ui font-medium text-ink-dim transition-colors duration-(--dur-state) hover:bg-well hover:text-ink focus-instrument"
              >
                {link.label}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-(--gap)">
            <SchemePicker />
            <ThemeToggle />
            <UserMenu />
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1180px] grid-cols-1 gap-(--gap-group) px-6 py-8 lg:grid-cols-[200px_minmax(0,1fr)] lg:gap-10">
        <TopicRail />
        <main className="min-w-0 space-y-8">
          <section>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
              The slopcad documentation
            </h1>
            <p className="mt-3 max-w-[72ch] text-body text-ink-dim">
              Every guide lives in the repository under{" "}
              <code className="rounded-[3px] border border-rule bg-well-deep px-1 py-px font-mono text-data text-ink">
                docs/guides/
              </code>
              , and every primary public API gets a runnable example under{" "}
              <code className="rounded-[3px] border border-rule bg-well-deep px-1 py-px font-mono text-data text-ink">
                packages/docs-examples/
              </code>{" "}
              that the workspace gates typecheck, build, and run.{" "}
              <code className="rounded-[3px] border border-rule bg-well-deep px-1 py-px font-mono text-data text-ink">
                pnpm verify
              </code>{" "}
              proves them, this page proves them again in your browser. The
              tables below are generated from the same source constants the code
              declares, not hand-maintained copies.
            </p>
            {/* The manual's own facts, as readouts rather than badges. */}
            <dl className="mt-4 flex flex-wrap items-center gap-x-(--gap-group) gap-y-2 border-t border-rule pt-2.5">
              <Readout label="topics">{String(topicCount)}</Readout>
              <Readout label="groups">{String(DOCS_GROUPS.length)}</Readout>
              <Readout label="kernels">
                {String(KERNEL_CAPABILITY_ROWS.length)}
              </Readout>
              <Readout label="examples">verify-gated</Readout>
            </dl>
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
              <SketchVocabularyExampleCard />
              <ReactExampleCard />
            </div>
          </Section>

          <Section
            id="kernels"
            title="Kernel capability matrix"
            lead="What each backend declares it can do, read from the kernels' own capability constants (packages/docs-examples/src/kernel/capabilities.ts). A declined operation answers the structured kernel/unsupported-operation, never a silently wrong result."
          >
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse">
                <caption className="sr-only">
                  Declared capabilities of the four geometry kernel backends
                </caption>
                <thead>
                  <tr className="border-b border-rule bg-well/60">
                    <th scope="col" className={TABLE_HEAD_CELL}>
                      capability
                    </th>
                    {KERNEL_CAPABILITY_ROWS.map((row) => (
                      <th
                        scope="col"
                        key={row.backendId}
                        className={`${TABLE_HEAD_CELL} text-center`}
                      >
                        {row.backendId}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {CAPABILITY_COLUMNS.map((column) => (
                    <tr key={column.flag} className={TABLE_ROW}>
                      <th
                        scope="row"
                        className="h-(--row-h) px-2 text-left text-ui font-normal text-ink-dim"
                      >
                        {column.label}
                      </th>
                      {KERNEL_CAPABILITY_ROWS.map((row) => {
                        const supported = row.capabilities[column.flag];
                        return (
                          <td
                            key={row.backendId}
                            className="h-(--row-h) px-2 text-center font-mono text-data tabular"
                            data-flag={`${row.backendId}:${column.flag}`}
                          >
                            <span
                              aria-hidden="true"
                              className={
                                supported ? "text-ink" : "text-ink-faint/60"
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
            </Panel>
            <p className="mt-2 font-mono text-micro text-ink-faint">
              ✓ declared · — declined (answers kernel/unsupported-operation)
            </p>
          </Section>

          <Section
            id="formats"
            title="Formats and parametric history"
            lead="One format preserves the parametric model. Everything else is geometry exchange: deliberate, provenance-marked, and never a fake history."
          >
            <Panel className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse">
                <caption className="sr-only">
                  Which exchange formats preserve parametric history
                </caption>
                <thead>
                  <tr className="border-b border-rule bg-well/60">
                    <th scope="col" className={TABLE_HEAD_CELL}>
                      format
                    </th>
                    <th scope="col" className={TABLE_HEAD_CELL}>
                      direction
                    </th>
                    <th scope="col" className={TABLE_HEAD_CELL}>
                      what a file carries
                    </th>
                    <th
                      scope="col"
                      className={`${TABLE_HEAD_CELL} text-center`}
                    >
                      parametric history
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {FORMAT_ROWS.map((row) => (
                    <tr key={row.format} className={TABLE_ROW}>
                      <th
                        scope="row"
                        className="px-2 py-1.5 text-left font-mono text-data font-normal text-ink"
                      >
                        {row.format}
                      </th>
                      <td className="px-2 py-1.5 text-ui text-ink-dim">
                        {row.direction}
                      </td>
                      <td className="px-2 py-1.5 text-ui text-ink-dim">
                        {row.carries}
                      </td>
                      {/* The one format that preserves history is the one
                          fact this table exists to state, so it is the only
                          cell allowed the signal colour. */}
                      <td className="px-2 py-1.5 text-center font-mono text-data tabular">
                        <span
                          className={
                            row.history
                              ? "font-medium text-signal"
                              : "text-ink-faint/60"
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
            </Panel>
          </Section>

          {DOCS_GROUPS.map((group) => (
            <Section
              key={group.id}
              id={`group-${group.id}`}
              title={group.title}
            >
              <Panel>
                <ul>
                  {group.topics.map((topic) => (
                    <li
                      key={topic.id}
                      id={`topic-${topic.id}`}
                      className="scroll-mt-14 border-b border-rule/60 px-(--pad-panel) py-2 transition-colors duration-(--dur-state) last:border-b-0 hover:bg-well"
                    >
                      <div className="flex flex-wrap items-baseline justify-between gap-x-(--gap-group) gap-y-1">
                        <h3 className="text-ui font-medium text-ink">
                          {topic.title}
                        </h3>
                        <code className="font-mono text-micro text-ink-faint">
                          {topic.guide}
                        </code>
                      </div>
                      <p className="mt-0.5 max-w-[80ch] text-ui text-ink-dim">
                        {topic.summary}
                      </p>
                      {topic.example !== null ? (
                        <p className="mt-1 font-mono text-micro text-ink-faint">
                          example: {topic.example}
                        </p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            </Section>
          ))}
        </main>
      </div>
    </div>
  );
}
