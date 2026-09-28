/**
 * The project card: name, one-line description, and the mono metadata
 * line (document count, last touch). Shared by the dashboard's recent
 * grid and the projects index, so both surfaces read the same way.
 */

import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import type { ProjectSummaryDto } from "@slopcad/api/routers/projects";

import { formatStamp, plural } from "@/utils/format";

export function ProjectCard({
  project,
}: {
  readonly project: ProjectSummaryDto;
}): ReactElement {
  return (
    <Link
      className="border-border bg-card hover:border-primary/50 group flex min-h-28 flex-col border p-4 transition-colors"
      params={{ projectId: project.id }}
      to="/projects/$projectId"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium">{project.name}</h3>
        <ChevronRight className="text-muted-foreground size-4 shrink-0 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      {project.description !== null && project.description !== "" ? (
        <p className="text-muted-foreground mt-1 line-clamp-2 text-xs leading-relaxed">
          {project.description}
        </p>
      ) : null}
      <div className="text-muted-foreground mt-auto flex items-center gap-2 pt-4 font-mono text-[11px]">
        {plural(project.documentCount, "document")}
        <span aria-hidden="true">·</span>
        {formatStamp(project.updatedAt)}
      </div>
    </Link>
  );
}
