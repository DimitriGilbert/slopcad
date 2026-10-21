import { createFileRoute } from "@tanstack/react-router";

import { DesignSystemPage } from "@/design/DesignSystemPage";

export const Route = createFileRoute("/design")({
  component: DesignSystemPage,
});
