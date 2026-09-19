import { createFileRoute } from "@tanstack/react-router";

import { DocsPage } from "@/docs-app/DocsPage";

export const Route = createFileRoute("/docs")({
  component: DocsPage,
});
