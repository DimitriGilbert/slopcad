import type {
  GeometryKernel,
  KernelBounds,
  KernelSolid,
} from "@slopcad/cad-kernel";
import { length } from "@slopcad/cad-core";
import type { CadComponent, ComponentBuild } from "../cad-component";
import type {
  ComponentKernel,
  ComponentKernelResult,
} from "../component-kernel";
import type { ComponentPortInstance } from "../component-contract";

import { directComponentKernel } from "../component-kernel";
import { nema17Mount, NEMA17_MOUNT_DEFAULT_PARAMETERS } from "../nema17-mount";
import {
  arduinoMount,
  ARDUINO_MOUNT_DEFAULT_PARAMETERS,
} from "../arduino-mount";
import { enclosure, ENCLOSURE_DEFAULT_PARAMETERS } from "../enclosure";

/** The x gap kept between neighbouring laid-out bodies (mm). */
const LAYOUT_GAP_MM = 20;

/** One measured, placed body of the assembly study. */
export interface AssemblyStudyBody {
  /** The source component's registry id (e.g. `"nema17-mount"`). */
  readonly componentId: string;
  /** The body's name within its component (e.g. `"plate"`, `"shell"`). */
  readonly name: string;
  /** The body's stable projection id from the component's preview metadata. */
  readonly bodyId: string;
  /** The placed solid, owned by the caller's kernel. */
  readonly solid: KernelSolid;
  /** The kernel-measured volume of the PLACED body (mm³). */
  readonly volumeMm3: number;
  /** The kernel-measured bounds of the PLACED body (mm). */
  readonly bounds: KernelBounds;
}

/** The structured result of one assembly study. */
export interface AssemblyStudy {
  /** The laid-out bodies, in layout order. */
  readonly bodies: readonly AssemblyStudyBody[];
  /** The sum of the placed bodies' kernel-measured volumes (mm³). */
  readonly totalVolumeMm3: number;
  /** The NEMA 17 mount's resolved ports at the built values. */
  readonly nema17Ports: readonly ComponentPortInstance[];
}

/** The study's structured failure: the refusing step, verbatim. */
export interface AssemblyStudyError {
  /** The component or step that refused (e.g. `"enclosure"`). */
  readonly step: string;
  /** The underlying failure code. */
  readonly code: string;
  /** The underlying failure message. */
  readonly message: string;
}

/** What one study call returns: the study, or the structured refusal. */
export type AssemblyStudyResult =
  | { readonly ok: true; readonly value: AssemblyStudy }
  | { readonly ok: false; readonly error: AssemblyStudyError };

/** Builds `component` at `values`, refusing structurally on failure. */
async function buildComponent(
  step: string,
  kernel: ComponentKernel,
  component: CadComponent,
  values: Record<string, number>,
): Promise<ComponentBuild | AssemblyStudyError> {
  const build = await component.build(kernel, values);
  if (!build.ok) {
    return {
      step,
      code: build.error.code,
      message: build.error.message,
    };
  }
  return build.value;
}

/** Unwraps a kernel measurement, converting refusal into the study error. */
async function measure(
  step: string,
  kernel: ComponentKernel,
  solid: KernelSolid,
): Promise<{ volumeMm3: number; bounds: KernelBounds } | AssemblyStudyError> {
  const volume = await kernel.volume(solid);
  if (!volume.ok) {
    return { step, code: volume.error.code, message: volume.error.message };
  }
  const bounds = await kernel.bounds(solid);
  if (!bounds.ok) {
    return { step, code: bounds.error.code, message: bounds.error.message };
  }
  return { volumeMm3: volume.value, bounds: bounds.value };
}

/** Translates `solid` by the x offset, refusing structurally on failure. */
async function place(
  kernel: ComponentKernel,
  solid: KernelSolid,
  dxMm: number,
): Promise<ComponentKernelResult<KernelSolid>> {
  return kernel.transform(solid, {
    x: length(dxMm),
    y: length(0),
    z: length(0),
  });
}

/**
 * Builds the three registry components through `kernel`, lays them out
 * along x (NEMA 17 mount, then the UNO mount, then the enclosure's shell
 * and lid) with {@link LAYOUT_GAP_MM} gaps measured from each build's own
 * bounds, and measures every placed body. The solids stay owned by the
 * caller's kernel — dispose them through it.
 */
export async function assemblyStudy(
  kernel: ComponentKernel,
  values: {
    readonly nema17?: Record<string, number>;
    readonly arduino?: Record<string, number>;
    readonly enclosure?: Record<string, number>;
  } = {},
): Promise<AssemblyStudyResult> {
  // Ownership ledger (dispose discipline): the study owns every solid its
  // three builds return plus every placed copy it mints, and the returned
  // value carries ONLY the placed copies — so each original is released
  // the moment its placed copy exists, and an early return releases
  // everything still held through the kernel that minted it.
  const unplaced: KernelSolid[] = [];
  const placedSoFar: KernelSolid[] = [];
  const fail = async (
    error: AssemblyStudyError,
  ): Promise<AssemblyStudyResult> => {
    for (const solid of [...unplaced, ...placedSoFar]) {
      await kernel.dispose(solid);
    }
    return { ok: false, error };
  };

  const nema17 = await buildComponent(
    "nema17-mount",
    kernel,
    nema17Mount,
    values.nema17 ?? NEMA17_MOUNT_DEFAULT_PARAMETERS,
  );
  if ("step" in nema17) return fail(nema17);
  unplaced.push(...nema17.bodies.map((body) => body.solid));
  const arduino = await buildComponent(
    "arduino-mount",
    kernel,
    arduinoMount,
    values.arduino ?? ARDUINO_MOUNT_DEFAULT_PARAMETERS,
  );
  if ("step" in arduino) return fail(arduino);
  unplaced.push(...arduino.bodies.map((body) => body.solid));
  const enclosureBuild = await buildComponent(
    "enclosure",
    kernel,
    enclosure,
    values.enclosure ?? ENCLOSURE_DEFAULT_PARAMETERS,
  );
  if ("step" in enclosureBuild) return fail(enclosureBuild);
  unplaced.push(...enclosureBuild.bodies.map((body) => body.solid));

  const bodies: AssemblyStudyBody[] = [];
  let cursorX = 0;
  let totalVolumeMm3 = 0;

  for (const [componentId, build] of [
    ["nema17-mount", nema17],
    ["arduino-uno-mount", arduino],
    ["electronics-enclosure", enclosureBuild],
  ] as const) {
    for (const body of build.bodies) {
      // Measure the body's own bounds first: each component builds in its
      // own canonical frame, so the placement translates by exactly the
      // offset that lands min.x on the layout cursor.
      const own = await measure(componentId, kernel, body.solid);
      if ("step" in own) return fail(own);
      const dxMm = cursorX - own.bounds.min[0];
      const placed = await place(kernel, body.solid, dxMm);
      if (!placed.ok) {
        return fail({
          step: componentId,
          code: placed.error.code,
          message: placed.error.message,
        });
      }
      // The placed copy replaces the original in the returned value; the
      // original's disposal is owed from here on regardless of outcome.
      await kernel.dispose(body.solid);
      unplaced.splice(unplaced.indexOf(body.solid), 1);
      placedSoFar.push(placed.value);
      const widthMm = own.bounds.max[0] - own.bounds.min[0];
      const bounds: KernelBounds = {
        max: [cursorX + widthMm, own.bounds.max[1], own.bounds.max[2]],
        min: [cursorX, own.bounds.min[1], own.bounds.min[2]],
      };
      bodies.push({
        bodyId: body.bodyId,
        bounds,
        componentId,
        name: body.name,
        solid: placed.value,
        volumeMm3: own.volumeMm3,
      });
      totalVolumeMm3 += own.volumeMm3;
      cursorX += widthMm + LAYOUT_GAP_MM;
    }
  }

  return {
    ok: true,
    value: {
      bodies,
      totalVolumeMm3,
      nema17Ports: nema17Mount.ports(
        values.nema17 ?? NEMA17_MOUNT_DEFAULT_PARAMETERS,
      ),
    },
  };
}

/**
 * The convenience entry for in-process kernels: one call over a plain
 * `GeometryKernel` (Manifold, JSCAD, …) — the same study, sync-kernel
 * flavor.
 */
export function assemblyStudyDirect(
  kernel: GeometryKernel,
  values: Parameters<typeof assemblyStudy>[1] = {},
): Promise<AssemblyStudyResult> {
  return assemblyStudy(directComponentKernel(kernel), values);
}
