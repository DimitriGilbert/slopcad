/**
 * The logged-in dashboard. The landing surface after sign-up: a glance
 * at the workspace (project count, document count, last activity) and
 * the projects nearest the top of the bench. Everything derives from
 * the one `projects.list` query — the list arrives sorted by update
 * time, so "recent" is the head of it and "last activity" is its first
 * row. Loading, error, and empty states are first-class: skeletons
 * match the final layout's shape, and a new user sees one clear way
 * into the product.
 *
 * The glance is a readout strip and the shelf is a panel of rows — the
 * same two devices the cockpit uses for exactly these two jobs.
 */

import { useQuery } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { Button } from "@slopcad/ui/components/button";
import { Panel, PanelHeader } from "@slopcad/ui/components/cockpit/panel";
import { Readout } from "@slopcad/ui/components/cockpit/property-row";
import { Skeleton } from "@slopcad/ui/components/skeleton";

import { AppPage, PageHeader } from "@/components/app/page";
import { ProjectRow } from "@/components/app/project-row";
import { formatStamp } from "@/utils/format";
import { useTRPC } from "@/utils/trpc";
import { useProjectsWebMcpTools } from "@/webmcp/projects-tools";

export const Route = createFileRoute("/_auth/dashboard")({
  component: RouteComponent,
});

const RECENT_COUNT = 8;

function RouteComponent(): ReactElement {
  const { session } = Route.useRouteContext();
  const trpc = useTRPC();
  const projectsQuery = useQuery(trpc.projects.list.queryOptions());
  useProjectsWebMcpTools();

  const projects = projectsQuery.data ?? [];
  const lastActivityAt = projects[0]?.updatedAt;
  const documentTotal = projects.reduce(
    (sum, project) => sum + project.documentCount,
    0,
  );

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
        <p className="text-ui text-destructive" role="alert">
          Projects could not be loaded: {projectsQuery.error.message}
        </p>
      ) : projects.length === 0 ? (
        <Panel>
          <PanelHeader title="Workspace" titleAs="h2" trailing="empty" />
          <div className="flex flex-col items-start gap-(--gap-group) p-(--gap-group)">
            <div>
              <p className="text-title text-ink">No projects yet</p>
              <p className="mt-1 max-w-[72ch] text-body text-ink-dim">
                Projects group documents, and each document keeps a model with
                its saved versions. Create the first one to start modeling.
              </p>
            </div>
            <Button render={<Link to="/projects" />} size="sm">
              New project
            </Button>
          </div>
        </Panel>
      ) : (
        <>
          {/* The glance: three facts, as the instrument states facts. */}
          <Panel aria-label="Workspace totals">
            <div className="flex flex-wrap items-center gap-x-(--gap-group) gap-y-2 p-(--pad-panel)">
              <Readout label="projects">{String(projects.length)}</Readout>
              <Readout label="documents">{String(documentTotal)}</Readout>
              <Readout label="last activity">
                {lastActivityAt === undefined
                  ? "never"
                  : formatStamp(lastActivityAt)}
              </Readout>
            </div>
          </Panel>
          <Panel aria-label="Recent projects" className="mt-(--gap-group)">
            <PanelHeader
              title="Recent projects"
              titleAs="h2"
              trailing={
                <Link
                  className="text-micro text-ink-dim transition-colors duration-(--dur-state) hover:text-ink focus-instrument"
                  to="/projects"
                >
                  all projects
                </Link>
              }
            />
            <ul data-testid="recent-project-list">
              {projects.slice(0, RECENT_COUNT).map((project) => (
                <li key={project.id}>
                  <ProjectRow project={project} />
                </li>
              ))}
            </ul>
          </Panel>
        </>
      )}
    </AppPage>
  );
}

function DashboardSkeleton(): ReactElement {
  return (
    <div aria-hidden="true">
      <Skeleton className="h-10 w-full" />
      <div className="mt-(--gap-group) flex flex-col gap-px">
        <Skeleton className="h-(--header-h) w-full" />
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-(--row-h-lg) w-full" />
        ))}
      </div>
    </div>
  );
}
