/**
 * The logged-in dashboard. The landing surface after sign-up: a glance
 * at the workspace (project count, document count, last activity) and
 * the projects nearest the top of the bench. Everything derives from
 * the one `projects.list` query — the list arrives sorted by update
 * time, so "recent" is the head of it and "last activity" is its first
 * row. Loading, error, and empty states are first-class: skeletons
 * match the final layout's shape, and a new user sees one clear way
 * into the product.
 */

import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Box, ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "@slopcad/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@slopcad/ui/components/empty";
import { Skeleton } from "@slopcad/ui/components/skeleton";

import { AppPage, PageHeader } from "@/components/app/page";
import { ProjectCard } from "@/components/app/project-card";
import { formatStamp } from "@/utils/format";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/_auth/dashboard")({
  component: RouteComponent,
});

const RECENT_COUNT = 6;

function RouteComponent(): ReactElement {
  const { session } = Route.useRouteContext();
  const trpc = useTRPC();
  const projectsQuery = useQuery(trpc.projects.list.queryOptions());

  const projects = projectsQuery.data ?? [];
  const lastActivityAt = projects[0]?.updatedAt;

  return (
    <AppPage>
      <PageHeader
        lead={
          projects.length === 0
            ? `Welcome, ${session?.user.name ?? "machinist"}.`
            : `Welcome back, ${session?.user.name ?? "machinist"}.`
        }
        title="Dashboard"
      />
      {projectsQuery.isPending ? (
        <DashboardSkeleton />
      ) : projectsQuery.isError ? (
        <p className="text-destructive text-sm" role="alert">
          Projects could not be loaded: {projectsQuery.error.message}
        </p>
      ) : projects.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Box />
            </EmptyMedia>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              Projects group documents, and each document keeps a model with its
              saved versions. Create the first one to start modeling.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button render={<Link to="/projects" />}>New project</Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
          <section
            aria-label="Workspace totals"
            className="border-border bg-card grid grid-cols-1 divide-y divide-border border sm:grid-cols-3 sm:divide-x sm:divide-y-0"
          >
            <StatCell label="Projects" value={String(projects.length)} />
            <StatCell
              label="Documents"
              value={String(
                projects.reduce(
                  (sum, project) => sum + project.documentCount,
                  0,
                ),
              )}
            />
            <StatCell
              label="Last activity"
              value={
                lastActivityAt === undefined
                  ? "never"
                  : formatStamp(lastActivityAt)
              }
            />
          </section>
          <section aria-label="Recent projects" className="mt-10">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-medium">Recent projects</h2>
              <Link
                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
                to="/projects"
              >
                All projects
                <ChevronRight className="size-3" />
              </Link>
            </div>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {projects.slice(0, RECENT_COUNT).map((project) => (
                <li key={project.id}>
                  <ProjectCard project={project} />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </AppPage>
  );
}

function StatCell({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): ReactElement {
  return (
    <div className="px-4 py-3">
      <div className="text-muted-foreground font-mono text-[11px] tracking-wider uppercase">
        {label}
      </div>
      <div className="mt-1 font-mono text-xl font-medium tabular-nums">
        {value}
      </div>
    </div>
  );
}

function DashboardSkeleton(): ReactElement {
  return (
    <div aria-hidden="true">
      <Skeleton className="h-[74px] w-full" />
      <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-28" />
        ))}
      </div>
    </div>
  );
}
