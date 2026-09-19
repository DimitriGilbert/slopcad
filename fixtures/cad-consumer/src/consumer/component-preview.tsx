/**
 * The consumer's usage of the installed CAD COMPONENT REGISTRY items
 * (Phase 33.2): the NEMA 17 mount — its contract, kernel adapter, and
 * component file all installed by the shadcn CLI — built on the main
 * thread through the Manifold kernel, projected, and rendered by the
 * installed `CadViewport`. The installed `CadParameterPanel` (a Formedible
 * form) edits the component's OWN contract parameters in prop mode; an
 * applied edit produces a new build, a new volume, and a new settled
 * frame. The installed `nema17-assembly-example` runs alongside for its
 * measured total.
 */

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type RenderCamera,
  type RenderProjection,
} from "@slopcad/cad-react";

import { CadParameterPanel } from "@/components/cad/cad-parameter-panel";
import type {
  CadParameterApply,
  CadParameterApplyOutcome,
} from "@/components/cad/cad-parameter-panel";
import { CadViewport } from "@/components/cad/cad-viewport";
import { directComponentKernel } from "@/cad/component-kernel";
import {
  componentParameterCollection,
  type ComponentParameterValues,
} from "@/cad/component-contract";
import { assemblyStudyDirect } from "@/cad/examples/nema17-assembly";
import {
  nema17Mount,
  NEMA17_MOUNT_DEFAULT_PARAMETERS,
  NEMA17_MOUNT_DEFINITION,
} from "@/cad/nema17-mount";
import { getPlateKernel } from "@/examples/plate-workbench/plate-geometry";

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

export function ComponentPreview(): ReactElement {
  const [values, setValues] = useState<ComponentParameterValues>(
    NEMA17_MOUNT_DEFAULT_PARAMETERS,
  );
  const [projection, setProjection] = useState<RenderProjection | null>(null);
  const [buildStatus, setBuildStatus] = useState("pending");
  const [buildError, setBuildError] = useState("");
  const [volumeText, setVolumeText] = useState("—");
  const [assemblyTotalText, setAssemblyTotalText] = useState("—");
  const [settledFrames, setSettledFrames] = useState(0);

  const valuesKey = useMemo(() => JSON.stringify(values), [values]);

  useEffect(() => {
    let cancelled = false;
    setBuildStatus("building");
    void (async () => {
      const kernel = await getPlateKernel();
      const componentKernel = directComponentKernel(kernel);
      const build = await nema17Mount.build(componentKernel, values);
      if (cancelled) return;
      if (!build.ok) {
        setBuildStatus("failed");
        setBuildError(`${build.error.code}: ${build.error.message}`);
        setProjection(null);
        return;
      }
      const body = build.value.bodies[0];
      if (body === undefined) {
        setBuildStatus("failed");
        setBuildError("the mount builds one body");
        return;
      }
      const volume = await componentKernel.volume(body.solid);
      const tessellation = await componentKernel.tessellate(body.solid);
      if (cancelled) return;
      if (!volume.ok || !tessellation.ok) {
        setBuildStatus("failed");
        setBuildError("kernel measurement failed");
        return;
      }
      const object = projectTessellation(MOUNT_BODY_ID, tessellation.value);
      if (!object.ok) {
        setBuildStatus("failed");
        setBuildError(object.error.message);
        return;
      }
      const scene = createRenderProjection([object.value], MOUNT_CAMERA);
      if (!scene.ok) {
        setBuildStatus("failed");
        setBuildError(scene.error.message);
        return;
      }
      setVolumeText(`${volume.value.toFixed(2)} mm³`);
      setProjection(scene.value);
      setBuildError("");
      setBuildStatus("ok");
      // The installed example runs on the same kernel with the current
      // mount values; its total covers all four laid-out bodies.
      const study = await assemblyStudyDirect(kernel, { nema17: values });
      if (cancelled) return;
      if (study.ok) {
        setAssemblyTotalText(`${study.value.totalVolumeMm3.toFixed(2)} mm³`);
        for (const studyBody of study.value.bodies) {
          await componentKernel.dispose(studyBody.solid);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // valuesKey carries the edited values; the effect re-runs per edit.
  }, [valuesKey]);

  const collection = useMemo(
    () => componentParameterCollection(NEMA17_MOUNT_DEFINITION, values),
    [valuesKey],
  );

  const onApply = useMemo<CadParameterApply>(
    () => (parameter, edit) => {
      if (edit.kind !== "value") {
        return {
          ok: false,
          error: {
            code: "consumer/component-preview",
            message: "Component parameters are literal values.",
          },
        };
      }
      const outcome: CadParameterApplyOutcome = { ok: true };
      setValues((previous) => ({
        ...previous,
        [parameter.name]: edit.value,
      }));
      return outcome;
    },
    [],
  );

  return (
    <section
      id="component-preview-root"
      aria-labelledby="component-preview-heading"
      className="w-full max-w-6xl space-y-3"
    >
      <h2 id="component-preview-heading" className="text-lg font-semibold">
        Parametric component — NEMA 17 stepper mount
      </h2>
      <p className="text-muted-foreground text-sm">
        The registry-installed component contract, kernel adapter, and mount
        built through the Manifold kernel; every panel edit rebuilds real
        geometry.
      </p>
      <div className="flex flex-wrap items-start gap-6">
        <div id="component-viewport" className="relative">
          <CadViewport
            className="h-[520px] w-[640px]"
            projection={projection}
            onSettled={() => {
              setSettledFrames((frames) => frames + 1);
            }}
          />
        </div>
        <div className="flex w-72 shrink-0 flex-col gap-4">
          {collection.ok ? (
            <CadParameterPanel
              className="w-72"
              parameters={collection.value.parameters}
              onApply={onApply}
              labels={{ submit: "Rebuild" }}
            />
          ) : (
            <p className="text-destructive text-sm" role="alert">
              The values no longer resolve against the definition.
            </p>
          )}
          <ul className="space-y-1 font-mono text-xs">
            <li>
              build ={" "}
              <span data-testid="component-build-status">{buildStatus}</span>
            </li>
            <li>
              frames ={" "}
              <span data-testid="component-settled-frames">
                {String(settledFrames)}
              </span>
            </li>
            <li>
              volume = <span data-testid="component-volume">{volumeText}</span>
            </li>
            <li>
              assembly total ={" "}
              <span data-testid="assembly-total-volume">
                {assemblyTotalText}
              </span>
            </li>
            <li className="text-destructive">
              <span data-testid="component-build-error">{buildError}</span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
