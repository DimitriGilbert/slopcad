/**
 * The project detail page: one project's document shelf beside its
 * create-document panel. Documents read as instrument rows — name,
 * version badge, mono save metadata — and the Open action hands the
 * document to the workbench. Loading and error states keep the page's
 * shape instead of collapsing it.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { ChevronLeft } from "lucide-react";
import type { ReactElement } from "react";
import { toast } from "sonner";
import { buttonVariants } from "@slopcad/ui/components/button";
import { Panel, PanelHeader } from "@slopcad/ui/components/cockpit/panel";
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
        <div aria-hidden="true" className="mt-(--gap-group)">
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="mt-2 h-5 w-96 max-w-full" />
          <div className="mt-(--gap-group) grid items-start gap-(--gap-group) lg:grid-cols-[minmax(0,1fr)_20rem]">
            <div className="flex flex-col gap-px">
              <Skeleton className="h-(--header-h) w-full" />
              <Skeleton className="h-(--row-h-lg) w-full" />
              <Skeleton className="h-(--row-h-lg) w-full" />
            </div>
            <Skeleton className="h-36" />
          </div>
        </div>
      </AppPage>
    );
  }

  if (projectQuery.isError) {
    return (
      <AppPage>
        <BackLink />
        <p className="mt-(--gap-group) text-ui text-destructive" role="alert">
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
      <div className="mt-(--gap-group)">
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
      <div className="grid items-start gap-(--gap-group) lg:grid-cols-[minmax(0,1fr)_20rem]">
        <aside className="lg:order-2 lg:sticky lg:top-(--gap-group)">
          <Panel data-testid="create-document-panel">
            <PanelHeader title="New document" titleAs="h2" />
            <div className="p-(--pad-panel)">
              <p className="mb-(--gap) text-ui text-ink-dim">
                One document holds one model and its saved versions.
              </p>
              <CreateDocumentForm onSubmitted={handleCreateDocument} />
            </div>
          </Panel>
        </aside>
        <Panel aria-label="Documents" className="lg:order-1">
          {/* Furniture, not document structure — the page's one heading
              is the project's name (see the projects index for why a
              second same-named heading is a hazard). */}
          <PanelHeader
            title="Documents"
            trailing={documentsQuery.isPending ? "…" : String(documents.length)}
          />
          {documentsQuery.isPending ? (
            <div aria-hidden="true" className="flex flex-col gap-px">
              <Skeleton className="h-(--row-h-lg) w-full" />
              <Skeleton className="h-(--row-h-lg) w-full" />
            </div>
          ) : documentsQuery.isError ? (
            <p
              className="p-(--pad-panel) text-ui text-destructive"
              role="alert"
            >
              Documents could not be loaded: {documentsQuery.error.message}
            </p>
          ) : documents.length === 0 ? (
            <div className="p-(--gap-group)">
              <p className="text-title text-ink">No documents yet</p>
              <p className="mt-1 max-w-[72ch] text-body text-ink-dim">
                Create one in the New document panel; it opens in the workbench
                unsaved at v0.
              </p>
            </div>
          ) : (
            <ul data-testid="document-list">
              {documents.map((document) => (
                <li
                  className="grid min-h-(--row-h-lg) grid-cols-[minmax(0,1fr)_auto] items-center gap-(--gap-group) border-b border-rule/60 px-(--pad-panel) py-1.5 transition-colors duration-(--dur-state) last:border-b-0 hover:bg-well"
                  key={document.id}
                >
                  <div className="flex min-w-0 flex-col">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-ui font-medium text-ink">
                        {document.name}
                      </span>
                      {document.versionCount > 0 ? (
                        /* The saved version is a measured fact, so it
                           reads as one: a mono tag, not a pill badge. */
                        <span className="shrink-0 rounded-[2px] border border-rule bg-well-deep px-1 font-mono text-micro text-ink-dim tabular">
                          {`v${String(document.latestVersion)}`}
                        </span>
                      ) : null}
                    </div>
                    <div className="font-mono text-micro text-ink-faint tabular">
                      {document.versionCount === 0
                        ? "never saved"
                        : plural(document.versionCount, "save")}
                      <span aria-hidden="true"> · </span>
                      {`updated ${formatStamp(document.updatedAt)}`}
                    </div>
                  </div>
                  <Link
                    className={buttonVariants({
                      size: "xs",
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
        </Panel>
      </div>
    </AppPage>
  );
}

function BackLink(): ReactElement {
  return (
    <Link
      className="inline-flex items-center gap-1 text-ui text-ink-dim transition-colors duration-(--dur-state) hover:text-ink focus-instrument"
      to="/projects"
    >
      <ChevronLeft className="size-3" />
      Projects
    </Link>
  );
}
