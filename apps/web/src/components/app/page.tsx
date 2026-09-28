/**
 * Shared scaffolding for the logged-in app pages (dashboard, projects,
 * project detail). The workbench and the docs manual own their full
 * frame; these pages live in one content column under the app bar, and
 * they all open with the same header: display-voice title, one-line
 * lead, optional mono metadata, optional actions on the baseline.
 */

import type { ReactElement, ReactNode } from "react";

export function AppPage({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      {children}
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
  readonly meta?: string;
  readonly actions?: ReactNode;
}): ReactElement {
  return (
    <header className="mb-10 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0">
        <h1 className="font-display text-foreground text-3xl font-semibold tracking-tight">
          {title}
        </h1>
        {lead ? (
          <p className="text-muted-foreground mt-2 max-w-[65ch] text-sm leading-relaxed">
            {lead}
          </p>
        ) : null}
        {meta ? (
          <p className="text-muted-foreground mt-2 font-mono text-xs">{meta}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
