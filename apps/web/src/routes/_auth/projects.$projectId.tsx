import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactElement } from "react";
import { toast } from "sonner";

import {
  CreateDocumentForm,
  type CreateDocumentValues,
} from "@/cad-projects/project-forms";
import { useTRPC } from "@/utils/trpc";

export const Route = createFileRoute("/_auth/projects/$projectId")({
  component: ProjectDetailPage,
});

function ProjectDetailPage(): ReactElement {
  const { projectId } = Route.useParams();
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const projectQuery = useQuery(trpc.projects.get.queryOptions({ projectId }));
  const documentsQuery = useQuery(
    trpc.documents.list.queryOptions({ projectId }),
  );

  const createDocumentMutation = useMutation(
    trpc.documents.create.mutationOptions({
      onSuccess: async (created) => {
        await queryClient.invalidateQueries({
          queryKey: trpc.documents.list.queryOptions({ projectId }).queryKey,
        });
        await queryClient.invalidateQueries({
          queryKey: trpc.projects.list.queryOptions().queryKey,
        });
        toast.success(`Document "${created.name}" created`);
      },
      onError: (error) => {
        toast.error(`Document refused: ${error.message}`);
      },
    }),
  );

  const handleCreateDocument = async (
    values: CreateDocumentValues,
  ): Promise<void> => {
    await createDocumentMutation.mutateAsync({
      projectId,
      name: values.name,
    });
  };

  if (projectQuery.isPending) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <p className="text-muted-foreground text-sm">Loading project…</p>
      </div>
    );
  }

  if (projectQuery.isError) {
    return (
      <div className="container mx-auto max-w-3xl px-4 py-8">
        <p className="text-destructive text-sm" role="alert">
          {projectQuery.error.message}
        </p>
        <Link
          to="/projects"
          className="text-muted-foreground mt-4 inline-block text-sm underline"
        >
          Back to projects
        </Link>
      </div>
    );
  }

  const project = projectQuery.data;
  const documents = documentsQuery.data ?? [];

  return (
    <div className="container mx-auto max-w-3xl px-4 py-8">
      <Link
        to="/projects"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
      >
        <ChevronLeft className="size-3" />
        Projects
      </Link>
      <header className="mt-3 mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          {project.name}
        </h1>
        {project.description !== null && project.description !== "" ? (
          <p className="text-muted-foreground mt-1 text-sm">
            {project.description}
          </p>
        ) : null}
      </header>

      <section
        aria-label="Create document"
        className="border-border bg-card mb-8 border p-4"
        data-testid="create-document-panel"
      >
        <h2 className="text-muted-foreground mb-3 text-xs font-medium tracking-wider uppercase">
          New document
        </h2>
        <CreateDocumentForm onSubmitted={handleCreateDocument} />
      </section>

      <section aria-label="Documents">
        <h2 className="text-muted-foreground mb-2 text-xs font-medium tracking-wider uppercase">
          Documents
        </h2>
        {documentsQuery.isPending ? (
          <p className="text-muted-foreground text-sm">Loading documents…</p>
        ) : documentsQuery.isError ? (
          <p className="text-destructive text-sm" role="alert">
            Documents could not be loaded: {documentsQuery.error.message}
          </p>
        ) : documents.length === 0 ? (
          <div className="text-muted-foreground border-border border border-dashed p-8 text-center text-sm">
            No documents yet. Create one above and open it in the workbench.
          </div>
        ) : (
          <ul className="divide-border divide-y" data-testid="document-list">
            {documents.map((document) => (
              <li
                key={document.id}
                className="flex items-center gap-3 px-2 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{document.name}</div>
                  <div className="text-muted-foreground mt-1 font-mono text-xs">
                    {document.versionCount === 0
                      ? "never saved"
                      : `v${String(document.latestVersion)} \u00B7 ${String(document.versionCount)} ${document.versionCount === 1 ? "save" : "saves"}`}
                    {" \u00B7 "}
                    updated {new Date(document.updatedAt).toLocaleString()}
                  </div>
                </div>
                <Link
                  to="/documents/$documentId"
                  params={{ documentId: document.id }}
                  className="border-border hover:bg-accent border px-2 py-1 text-xs"
                >
                  Open
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
