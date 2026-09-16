import { createFileRoute } from "@tanstack/react-router";

import { MeshIoPage } from "@/io-fixture/MeshIoPage";

export const Route = createFileRoute("/io")({
  component: MeshIoPage,
});
