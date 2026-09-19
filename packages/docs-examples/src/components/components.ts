/**
 * The `reusable components` guide's runnable example
 * (docs/guides/components.md): the Phase 32 component surface — the
 * shipped NEMA 17 mount built through `directComponentKernel` over a real
 * kernel (geometry through the public contract alone), its ports
 * resolved kernel-free, a contract-parameter edit changing the measured
 * volume, and a CUSTOM component defined with `defineComponent` and
 * built the same way. The registry story (Phase 33) is the same files
 * arriving through `shadcn add` — see docs/guides/registry.md.
 */

import {
  COMPONENT_CONTRACT_VERSION,
  PHASE32_COMPONENTS,
  defineComponent,
  directComponentKernel,
  nema17Mount,
  NEMA17_MOUNT_DEFAULT_PARAMETERS,
  resolveComponentParameters,
  type CadComponent,
  type CadComponentDefinition,
  type ComponentParameterValues,
} from "@slopcad/cad-components";
import { length, type BodyId, createBodyId } from "@slopcad/cad-core";
import {
  manifoldKernelFromRuntime,
  type ManifoldRuntime,
} from "@slopcad/cad-kernel-manifold";
import type { GeometryKernel, KernelSolid } from "@slopcad/cad-kernel";

/** The washer example's parameters (mm). */
const WASHER_INNER_MM = 8;
const WASHER_OUTER_MM = 20;
const WASHER_THICKNESS_MM = 2;

/** The example's washer body id. */
const WASHER_BODY: BodyId = createBodyId("body_guide_washer");

/** What the example reports back to the guide and the docs page. */
export interface ComponentsExampleSummary {
  readonly nema17Bodies: number;
  readonly nema17VolumeMm3: number;
  readonly nema17EditedVolumeMm3: number;
  readonly nema17PortCount: number;
  readonly washerInnerDiameterMm: number;
  readonly washerOuterDiameterMm: number;
  readonly washerVolumeMm3: number;
  readonly phase32ComponentIds: readonly string[];
}

/** The custom component the example defines: a simple washer. */
const washerDefinition: CadComponentDefinition = defineComponent({
  contractVersion: COMPONENT_CONTRACT_VERSION,
  id: "guide-washer",
  name: "Guide Washer",
  description:
    "The reusable-components guide's example component: one washer from two cylinders and a boolean subtract.",
  version: "0.1.0",
  parameters: [
    {
      name: "innerDiameterMm",
      description: "The bore's diameter.",
      dimension: "length",
      defaultValue: 8,
      min: 1,
    },
    {
      name: "outerDiameterMm",
      description: "The outer diameter.",
      dimension: "length",
      defaultValue: 20,
      min: 2,
    },
    {
      name: "thicknessMm",
      description: "The washer's thickness.",
      dimension: "length",
      defaultValue: 2,
      min: 0.5,
    },
  ],
  ports: [
    {
      name: "bore",
      description: "The central bore.",
      kind: "hole",
    },
  ],
  preview: {
    bodyIds: [String(WASHER_BODY)],
    viewport: { widthPx: 360, heightPx: 240 },
  },
});

/** The washer component: validated parameters, then real kernel geometry. */
const washer: CadComponent = {
  definition: washerDefinition,
  async build(kernel, values) {
    const resolved = resolveComponentParameters(washerDefinition, values);
    if (!resolved.ok) {
      return {
        ok: false,
        error: {
          code: resolved.error.code,
          message: resolved.error.message,
          input: resolved.error.input,
        },
      };
    }
    const value = (name: string): number => resolved.value.get(name);
    const outer = await kernel.createCylinder({
      radius: length(value("outerDiameterMm") / 2),
      height: length(value("thicknessMm")),
    });
    if (!outer.ok) {
      return {
        ok: false,
        error: {
          code: outer.error.code,
          message: outer.error.message,
          input: null,
        },
      };
    }
    const bore = await kernel.createCylinder({
      radius: length(value("innerDiameterMm") / 2),
      height: length(value("thicknessMm")),
    });
    if (!bore.ok) {
      return {
        ok: false,
        error: {
          code: bore.error.code,
          message: bore.error.message,
          input: null,
        },
      };
    }
    const washer = await kernel.subtract(outer.value, [bore.value]);
    if (!washer.ok) {
      return {
        ok: false,
        error: {
          code: washer.error.code,
          message: washer.error.message,
          input: null,
        },
      };
    }
    return {
      ok: true,
      value: {
        bodies: [
          { name: "washer", bodyId: String(WASHER_BODY), solid: washer.value },
        ],
      },
    };
  },
  ports(values) {
    const resolved = resolveComponentParameters(washerDefinition, values);
    const inner = resolved.ok ? resolved.value.get("innerDiameterMm") : 8;
    return [
      {
        name: "bore",
        kind: "hole",
        position: [0, 0, 0],
        axis: 3,
        diameter: inner,
      },
    ];
  },
};

/** A build's measured volume, through the kernel the build ran on. */
function volumeOfBuild(kernel: GeometryKernel, solid: KernelSolid): number {
  const measured = kernel.volume(solid);
  if (!measured.ok) {
    throw new Error(`Measuring a build failed: ${measured.error.message}`);
  }
  return measured.value;
}

/**
 * Runs the component tour against a Manifold runtime the caller boots
 * once (the runtime is expensive; the example takes it as a parameter).
 */
export async function runComponentsExample(
  runtime: ManifoldRuntime,
): Promise<ComponentsExampleSummary> {
  const kernel = manifoldKernelFromRuntime(runtime);
  const direct = directComponentKernel(kernel);

  // The shipped NEMA 17 mount at its default parameters.
  const nema = await nema17Mount.build(direct, NEMA17_MOUNT_DEFAULT_PARAMETERS);
  if (!nema.ok) {
    throw new Error(`The NEMA 17 mount build failed: ${nema.error.message}`);
  }
  const shell = nema.value.bodies[0];
  if (shell === undefined) {
    throw new Error("The NEMA 17 mount built no bodies.");
  }

  // One contract-parameter edit: a bigger plate changes the volume.
  const edited = await nema17Mount.build(direct, {
    ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
    plateSizeMm: 52,
  });
  if (!edited.ok) {
    throw new Error(`The edited NEMA 17 build failed: ${edited.error.message}`);
  }
  const editedShell = edited.value.bodies[0];
  if (editedShell === undefined) {
    throw new Error("The edited NEMA 17 build produced no bodies.");
  }

  // Ports resolve without any kernel involvement.
  const ports = nema17Mount.ports(NEMA17_MOUNT_DEFAULT_PARAMETERS);

  // The custom washer, built the same way through the same kernel.
  const washerValues: ComponentParameterValues = {
    innerDiameterMm: WASHER_INNER_MM,
    outerDiameterMm: WASHER_OUTER_MM,
    thicknessMm: WASHER_THICKNESS_MM,
  };
  const built = await washer.build(direct, washerValues);
  if (!built.ok) {
    throw new Error(`The washer build failed: ${built.error.message}`);
  }
  const washerBody = built.value.bodies[0];
  if (washerBody === undefined) {
    throw new Error("The washer build produced no bodies.");
  }

  return {
    nema17Bodies: nema.value.bodies.length,
    nema17VolumeMm3: volumeOfBuild(kernel, shell.solid),
    nema17EditedVolumeMm3: volumeOfBuild(kernel, editedShell.solid),
    nema17PortCount: ports.length,
    washerInnerDiameterMm: WASHER_INNER_MM,
    washerOuterDiameterMm: WASHER_OUTER_MM,
    washerVolumeMm3: volumeOfBuild(kernel, washerBody.solid),
    phase32ComponentIds: PHASE32_COMPONENTS.map(
      (component) => component.definition.id,
    ),
  };
}
