import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { toast } from "sonner";

import {
  CreateProjectForm,
  type CreateProjectValues,
} from "@/cad-projects/project-forms";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/_auth/projects/")({
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
    <div className="container mx-auto max-w-3xl px-4 py-8">
      <header className="mb-8">
        <p className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
          Workspace — {session?.user.name}
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
      </header>

      <section
        aria-label="Create project"
        className="border-border bg-card mb-8 border p-4"
        data-testid="create-project-panel"
      >
        <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-wider uppercase">
          New project
        </h2>
        <CreateProjectForm onSubmitted={handleCreate} />
      </section>

      <section aria-label="Your projects">
        {projectsQuery.isPending ? (
          <p className="text-muted-foreground text-sm">Loading projects…</p>
        ) : projectsQuery.isError ? (
          <p className="text-destructive text-sm" role="alert">
            Projects could not be loaded: {projectsQuery.error.message}
          </p>
        ) : projects.length === 0 ? (
          <div className="text-muted-foreground border-border border border-dashed p-8 text-center text-sm">
            No projects yet. Name one above to start a model.
          </div>
        ) : (
          <ul className="divide-border divide-y" data-testid="project-list">
            {projects.map((project) => (
              <li key={project.id}>
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.id }}
                  className="hover:bg-accent group flex items-center gap-3 px-2 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{project.name}</div>
                    {project.description !== null &&
                    project.description !== "" ? (
                      <div className="text-muted-foreground truncate text-xs">
                        {project.description}
                      </div>
                    ) : null}
                    <div className="text-muted-foreground mt-1 font-mono text-xs">
                      {String(project.documentCount)}
                      {project.documentCount === 1 ? " document" : " documents"}
                      {" \u00B7 "}
                      updated {new Date(project.updatedAt).toLocaleString()}
                    </div>
                  </div>
                  <ChevronRight className="text-muted-foreground size-4" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
