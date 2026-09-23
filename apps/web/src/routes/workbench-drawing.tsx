import { createFileRoute } from "@tanstack/react-router";

import { DrawingSheetWorkbench } from "@/cad-workbench/drawing-sheet-workbench";

export const Route = createFileRoute("/workbench-drawing")({
  component: DrawingSheetWorkbench,
});
