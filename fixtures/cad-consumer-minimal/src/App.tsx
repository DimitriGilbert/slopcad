/**
 * The MINIMAL consumer's page (Phase 35.4): the smallest real usage of the
 * registry — the installed `nema17-mount` component (with its
 * contract/kernel/adapter registry dependencies) built through the
 * Manifold kernel on the main thread, projected, and rendered by the
 * installed `CadViewport` — nothing else. If this page typechecks, builds,
 * and settles in a browser, the minimal install path works.
 */

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type RenderCamera,
  type RenderProjection,
} from "@slopcad/cad-react";

import { CadViewport } from "@/components/cad/cad-viewport";
import { directComponentKernel } from "@/cad/component-kernel";
import {
  nema17Mount,
  NEMA17_MOUNT_DEFAULT_PARAMETERS,
  NEMA17_MOUNT_DEFINITION,
} from "@/cad/nema17-mount";
import { getKernel } from "@/consumer/kernel";

/** The deterministic home-view camera for the mount scene (z-up). */
const MOUNT_CAMERA: RenderCamera = {
  kind: "perspective",
  position: [70, -52, 64],
  target: [23, 23, 4.75],
  up: [0, 0, 1],
  fovDeg: 40,
};

/** The mount's stable projection body id from its preview metadata. */
const MOUNT_BODY_ID = createBodyId(
  NEMA17_MOUNT_DEFINITION.preview.bodyIds[0] ?? "body_nema17-mount",
);

export function App(): ReactElement {
  const [projection, setProjection] = useState<RenderProjection | null>(null);
  const [status, setStatus] = useState("pending");
  const [volumeText, setVolumeText] = useState("—");
  const [settled, setSettled] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("building");
    void (async () => {
      const kernel = await getKernel();
      const componentKernel = directComponentKernel(kernel);
      const build = await nema17Mount.build(
        componentKernel,
        NEMA17_MOUNT_DEFAULT_PARAMETERS,
      );
      if (cancelled) return;
      if (!build.ok) {
        setStatus(`failed: ${build.error.code}`);
        return;
      }
      const body = build.value.bodies[0];
      if (body === undefined) {
        setStatus("failed: the mount builds one body");
        return;
      }
      const volume = await componentKernel.volume(body.solid);
      const tessellation = await componentKernel.tessellate(body.solid);
      if (cancelled) return;
      if (!volume.ok || !tessellation.ok) {
        setStatus("failed: kernel measurement failed");
        return;
      }
      const object = projectTessellation(MOUNT_BODY_ID, tessellation.value);
      if (!object.ok) {
        setStatus(`failed: ${object.error.code}`);
        return;
      }
      const scene = createRenderProjection([object.value], MOUNT_CAMERA);
      if (!scene.ok) {
        setStatus(`failed: ${scene.error.code}`);
        return;
      }
      await componentKernel.dispose(body.solid);
      if (cancelled) return;
      setVolumeText(`${volume.value.toFixed(2)} mm³`);
      setProjection(scene.value);
      setStatus("ok");
    })().catch((error: unknown) => {
      if (!cancelled) setStatus(`failed: ${String(error)}`);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold">
        slopcad minimal registry consumer
      </h1>
      <p
        id="minimal-root"
        data-status={status}
        data-volume={status === "ok" ? volumeText : ""}
        data-settled={settled}
        className="text-sm text-muted-foreground"
      >
        nema17-mount: {status} · volume {volumeText} · settled frames{" "}
        {String(settled)}
      </p>
      <div className="h-[480px]">
        <CadViewport
          projection={projection}
          className="h-full"
          onSettled={() => {
            setSettled((count) => count + 1);
          }}
        />
      </div>
    </main>
  );
}
