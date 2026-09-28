/**
 * The projects index: the workspace's shelf. Two-region layout on wide
 * screens — the project cards on the left, the create panel pinned
 * beside them; stacked on small screens with the panel first, where the
 * empty workspace needs it. Cards, skeletons, and the empty state share
 * components with the dashboard so the two surfaces stay one system.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Box } from "lucide-react";
import type { ReactElement } from "react";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@slopcad/ui/components/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@slopcad/ui/components/empty";
import { Skeleton } from "@slopcad/ui/components/skeleton";

import {
  CreateProjectForm,
  type CreateProjectValues,
} from "@/cad-projects/project-forms";
import { AppPage, PageHeader } from "@/components/app/page";
import { ProjectCard } from "@/components/app/project-card";
import { plural } from "@/utils/format";
import { useTRPC } from "@/utils/trpc";

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
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <aside className="lg:order-2 lg:sticky lg:top-16">
          <Card data-testid="create-project-panel">
            <CardHeader>
              <CardTitle>New project</CardTitle>
              <CardDescription>
                Projects group documents and their version history.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CreateProjectForm onSubmitted={handleCreate} />
            </CardContent>
          </Card>
        </aside>
        <section aria-label="Your projects" className="lg:order-1">
          {projectsQuery.isPending ? (
            <div aria-hidden="true" className="grid gap-3 md:grid-cols-2">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-28" />
              ))}
            </div>
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
                  Name one in the New project panel and it appears here, ready
                  for its first document.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul
              className="grid gap-3 md:grid-cols-2"
              data-testid="project-list"
            >
              {projects.map((project) => (
                <li key={project.id}>
                  <ProjectCard project={project} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppPage>
  );
}
