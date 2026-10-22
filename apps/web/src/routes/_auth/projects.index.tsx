/**
 * The projects index: the workspace's shelf. Two regions on wide screens
 * — the project rows on the left, the create panel pinned beside them;
 * stacked on small screens with the panel first, where the empty
 * workspace needs it. Rows, skeletons, and the empty state share
 * components with the dashboard so the two surfaces stay one system.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { Panel, PanelHeader } from "@slopcad/ui/components/cockpit/panel";
import { Skeleton } from "@slopcad/ui/components/skeleton";

import {
  CreateProjectForm,
  type CreateProjectValues,
} from "@/cad-projects/project-forms";
import { AppPage, PageHeader } from "@/components/app/page";
import { ProjectRow } from "@/components/app/project-row";
import { plural } from "@/utils/format";
import { useTRPC } from "@/utils/trpc";
import { useProjectsWebMcpTools } from "@/webmcp/projects-tools";

export const Route = createFileRoute("/_auth/projects/")({
  head: () => ({
    meta: [
      {
        title: "Projects · slopcad",
      },
    ],
  }),
  component: ProjectsPage,
});

function ProjectsPage(): ReactElement {
  const { session } = Route.useRouteContext();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const projectsQuery = useQuery(trpc.projects.list.queryOptions());
  useProjectsWebMcpTools();

  const createMutation = useMutation(
    trpc.projects.create.mutationOptions({
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.list.queryOptions().queryKey,
        });
        toast.success(`Project "${created.name}" created`);
      },
      onError: (error) => {
        toast.error(`Project refused: ${error.message}`);
      },
    }),
  );

  const handleCreate = async (values: CreateProjectValues): Promise<void> => {
    await createMutation.mutateAsync({
      name: values.name,
      description: values.description === "" ? undefined : values.description,
    });
  };

  const projects = projectsQuery.data ?? [];

  return (
    <AppPage>
      <PageHeader
        lead={`Workspace of ${session?.user.name ?? "unknown"}. Every project groups its documents and their saved versions.`}
        meta={
          projects.length > 0 ? plural(projects.length, "project") : undefined
        }
        title="Projects"
      />
      <div className="grid items-start gap-(--gap-group) lg:grid-cols-[minmax(0,1fr)_20rem]">
        <aside className="lg:order-2 lg:sticky lg:top-(--gap-group)">
          <Panel data-testid="create-project-panel">
            <PanelHeader title="New project" titleAs="h2" />
            <div className="p-(--pad-panel)">
              <p className="mb-(--gap) text-ui ink-dim">
                Projects group documents and their version history.
              </p>
              <CreateProjectForm onSubmitted={handleCreate} />
            </div>
          </Panel>
        </aside>
        <Panel aria-label="Your projects" className="lg:order-1">
          {/* Deliberately NOT a heading: the page's h1 already says
              "Projects", and a second heading whose accessible name
              contains that word makes every `getByRole("heading", { name:
              "Projects" })` ambiguous. A panel is furniture (see the
              Panel primitive) — the region carries the name instead. */}
          <PanelHeader
            title="Your projects"
            trailing={projectsQuery.isPending ? "…" : String(projects.length)}
          />
          {projectsQuery.isPending ? (
            <div aria-hidden="true" className="flex flex-col gap-px">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-(--row-h-lg) w-full" />
              ))}
            </div>
          ) : projectsQuery.isError ? (
            <p
              className="p-(--pad-panel) text-ui text-destructive"
              role="alert"
            >
              Projects could not be loaded: {projectsQuery.error.message}
            </p>
          ) : projects.length === 0 ? (
            <div className="p-(--gap-group)">
              <p className="text-title ink">No projects yet</p>
              <p className="mt-1 max-w-[72ch] text-body ink-dim">
                Name one in the New project panel and it appears here, ready for
                its first document.
              </p>
            </div>
          ) : (
            <ul data-testid="project-list">
              {projects.map((project) => (
                <li key={project.id}>
                  <ProjectRow project={project} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </AppPage>
  );
}
