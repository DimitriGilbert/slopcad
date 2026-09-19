import { createFileRoute } from "@tanstack/react-router";

import { ProjectWorkbenchPage } from "@/cad-projects/ProjectWorkbenchPage";

export const Route = createFileRoute("/_auth/documents/$documentId")({
  component: ProjectDocumentWorkbench,
});

function ProjectDocumentWorkbench() {
  return <ProjectWorkbenchPage />;
}
