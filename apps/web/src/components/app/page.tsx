/**
 * Shared scaffolding for the logged-in app pages (dashboard, projects,
 * project detail). The workbench and the docs manual own their full
 * frame; these pages live in one content column under the app bar.
 *
 * The column and the header are built from the cockpit tokens, at the
 * product's density: these are workspace shelves, not marketing pages, so
 * the header states the surface and gets out of the way, and the facts
 * about the workspace ride the header as readouts rather than as prose.
 */

import type { ReactElement, ReactNode } from "react";

export function AppPage({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="h-full overflow-y-auto bg-chrome">
      <main className="mx-auto w-full max-w-[1180px] px-4 py-8 sm:px-6">
        {children}
      </main>
    </div>
  );
}

export function PageHeader({
  title,
  lead,
  meta,
  actions,
}: {
  readonly title: string;
  readonly lead?: string;
  /** One mono fact about the surface (count, timestamp). */
  readonly meta?: string;
  readonly actions?: ReactNode;
}): ReactElement {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-(--gap-group) gap-y-(--gap)">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-tight ink">
          {title}
        </h1>
        {lead === undefined || lead === "" ? null : (
          <p className="mt-2 max-w-[72ch] text-body ink-dim">{lead}</p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-(--gap-group)">
        {meta === undefined || meta === "" ? null : (
          <span className="font-mono text-data ink-faint tabular">{meta}</span>
        )}
        {actions}
      </div>
    </header>
  );
}
