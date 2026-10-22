/**
 * The project row: the unit of the workspace shelf.
 *
 * It was a card. A card spends 112px and a border on three facts; the
 * product's own idiom — the model tree, the timeline, the surface index
 * on the front door — is a dense row, so a shelf of twelve projects is
 * readable at a glance instead of being a grid to scroll. Name and
 * description on the left, the counts and the last touch right in tabular
 * mono, one hairline between rows, the whole row the link.
 *
 * Hover lifts the SURFACE (`well`), never the accent: hovering is not
 * arming, selecting or confirming, which are the accent's only three
 * jobs in this product.
 */

import { Link } from "@tanstack/react-router";
import type { ReactElement } from "react";
import type { ProjectSummaryDto } from "@slopcad/api/routers/projects";

import { formatStamp, plural } from "@/utils/format";

export function ProjectRow({
  project,
}: {
  readonly project: ProjectSummaryDto;
}): ReactElement {
  const described =
    project.description !== null && project.description !== ""
      ? project.description
      : null;
  return (
    <Link
      className="grid min-h-(--row-h-lg) grid-cols-[minmax(0,1fr)_auto] items-center gap-(--gap-group) border-b border-rule/60 px-(--pad-panel) py-2 transition-colors duration-(--dur-state) ease-(--ease-instrument) hover:bg-well focus-instrument"
      params={{ projectId: project.id }}
      to="/projects/$projectId"
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-ui font-medium ink">{project.name}</span>
        {described === null ? null : (
          <span className="truncate text-ui ink-dim">{described}</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-(--gap-group) font-mono text-micro ink-faint tabular">
        <span>{plural(project.documentCount, "document")}</span>
        <span>{formatStamp(project.updatedAt)}</span>
      </span>
    </Link>
  );
}
