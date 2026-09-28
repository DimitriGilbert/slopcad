/**
 * The project detail page: one project's document shelf beside its
 * create-document panel. Documents read as instrument rows — name,
 * version badge, mono save metadata — and the Open action hands the
 * document to the workbench. Loading and error states keep the page's
 * shape instead of collapsing it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { Box, ChevronLeft } from "lucide-react";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { Badge } from "@slopcad/ui/components/badge";
import { buttonVariants } from "@slopcad/ui/components/button";
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
  CreateDocumentForm,
  type CreateDocumentValues,
} from "@/cad-projects/project-forms";
import { AppPage, PageHeader } from "@/components/app/page";
import { formatStamp, plural } from "@/utils/format";
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
      <AppPage>
        <BackLink />
        <div aria-hidden="true" className="mt-6">
          <Skeleton className="h-9 w-72 max-w-full" />
          <Skeleton className="mt-3 h-5 w-96 max-w-full" />
          <div className="mt-10 grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="space-y-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
            <Skeleton className="h-40" />
          </div>
        </div>
      </AppPage>
    );
  }

  if (projectQuery.isError) {
    return (
      <AppPage>
        <BackLink />
        <p className="text-destructive mt-8 text-sm" role="alert">
          {projectQuery.error.message}
        </p>
      </AppPage>
    );
  }

  const project = projectQuery.data;
  const documents = documentsQuery.data ?? [];

  return (
    <AppPage>
      <BackLink />
      <div className="mt-6">
        <PageHeader
          lead={
            project.description !== null && project.description !== ""
              ? project.description
              : undefined
          }
          meta={`created ${formatStamp(project.createdAt)}`}
          title={project.name}
        />
      </div>
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <aside className="lg:order-2 lg:sticky lg:top-16">
          <Card data-testid="create-document-panel">
            <CardHeader>
              <CardTitle>New document</CardTitle>
              <CardDescription>
                One document holds one model and its saved versions.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CreateDocumentForm onSubmitted={handleCreateDocument} />
            </CardContent>
          </Card>
        </aside>
        <section aria-label="Documents" className="lg:order-1">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-medium">Documents</h2>
            {documentsQuery.isPending ? null : (
              <span className="text-muted-foreground font-mono text-xs">
                {plural(documents.length, "document")}
              </span>
            )}
          </div>
          {documentsQuery.isPending ? (
            <div aria-hidden="true" className="space-y-3">
              <Skeleton className="h-20" />
              <Skeleton className="h-20" />
            </div>
          ) : documentsQuery.isError ? (
            <p className="text-destructive text-sm" role="alert">
              Documents could not be loaded: {documentsQuery.error.message}
            </p>
          ) : documents.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Box />
                </EmptyMedia>
                <EmptyTitle>No documents yet</EmptyTitle>
                <EmptyDescription>
                  Create one in the New document panel; it opens in the
                  workbench unsaved at v0.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="space-y-3" data-testid="document-list">
              {documents.map((document) => (
                <li
                  className="border-border bg-card flex items-center gap-4 border p-4"
                  key={document.id}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2.5">
                      <span className="truncate text-sm font-medium">
                        {document.name}
                      </span>
                      {document.versionCount > 0 ? (
                        <Badge variant="outline">
                          {`v${String(document.latestVersion)}`}
                        </Badge>
                      ) : null}
                    </div>
                    <div className="text-muted-foreground mt-1.5 font-mono text-[11px]">
                      {document.versionCount === 0
                        ? "never saved"
                        : plural(document.versionCount, "save")}
                      <span aria-hidden="true"> · </span>
                      {`updated ${formatStamp(document.updatedAt)}`}
                    </div>
                  </div>
                  <Link
                    className={buttonVariants({
                      size: "sm",
                      variant: "outline",
                    })}
                    params={{ documentId: document.id }}
                    to="/documents/$documentId"
                  >
                    Open
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </AppPage>
  );
}

function BackLink(): ReactElement {
  return (
    <Link
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
      to="/projects"
    >
      <ChevronLeft className="size-3" />
      Projects
    </Link>
  );
}
