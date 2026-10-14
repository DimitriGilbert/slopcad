/**
 * The part renderers' busy affordance (PLAN-AGENT-CHAT Phase 4.3): the inline
 * spinner status rows use while a part streams. The ring itself is the ported
 * `../spinner` template primitive (deduped off the former local copy); this
 * module owns only the part sizing and the shared muted status row.
 */

import type { ReactElement } from "react";

import { Spinner } from "../spinner";

/**
 * One small inline busy ring, sized to sit in an xs text row. Decorative
 * (`aria-hidden`): every consumer renders the status text beside it.
 */
export function PartSpinner(): ReactElement {
  return <Spinner aria-hidden="true" className="size-3 shrink-0" />;
}

/** The shared muted status row: spinner + text, the template's running-tool line. */
export function PartStatusLine({
  children,
}: {
  children: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-2 px-1.5 text-xs text-muted-foreground">
      <PartSpinner />
      <span className="leading-none">{children}</span>
    </div>
  );
}
