import { createFileRoute } from "@tanstack/react-router";

import { SimGpuOraclePage } from "@/sim-gpu-fixture/SimGpuOraclePage";

export const Route = createFileRoute("/sim-gpu")({
  component: SimGpuOraclePage,
});
