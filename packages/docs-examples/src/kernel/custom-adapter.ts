/**
 * The `custom kernel adapters` guide's runnable example
 * (docs/guides/custom-kernels.md): a complete kernel adapter built on the
 * public contract — `withOperationLog` wraps ANY `GeometryKernel` and
 * delegates every contract operation, recording the operation names it
 * sees. The kernel contract's suite (`defineKernelContractSuite`) judges
 * the wrapper green over its inner kernel, which is the guide's proof
 * that "any conforming kernel" means exactly what it says: implement the
 * interface honestly and everything above it works unchanged.
 */

import type { KernelSolid } from "@slopcad/cad-kernel";
import {
  createFakeKernel,
  type BoxInput,
  type ChamferInput,
  type ConeInput,
  type CylinderInput,
  type FilletInput,
  type GeometryKernel,
  type KernelResult,
  type MirrorInput,
  type ProfileExtrudeInput,
  type ProfileLoftInput,
  type ProfileRevolveInput,
  type ProfileSweepInput,
  type ShellInput,
  type SphereInput,
  type TransformInput,
} from "@slopcad/cad-kernel";

/** A kernel that delegates every operation and records the call names. */
export interface LoggedKernel extends GeometryKernel {
  /** The operation names seen so far, in call order. */
  readonly operations: readonly string[];
}

/**
 * Wraps `kernel` with an operation log. Every contract method delegates
 * verbatim — handles, results, and failures cross unchanged — and the
 * wrapper adds nothing to the geometry. This is the smallest honest
 * adapter: a real one maps the contract onto an engine of its own.
 */
export function withOperationLog(kernel: GeometryKernel): LoggedKernel {
  const operations: string[] = [];
  const log = <T>(
    name: string,
    run: () => KernelResult<T>,
  ): KernelResult<T> => {
    operations.push(name);
    return run();
  };
  return {
    id: kernel.id,
    capabilities: kernel.capabilities,
    createBox: (input: BoxInput) =>
      log("createBox", () => kernel.createBox(input)),
    createSphere: (input: SphereInput) =>
      log("createSphere", () => kernel.createSphere(input)),
    createCylinder: (input: CylinderInput) =>
      log("createCylinder", () => kernel.createCylinder(input)),
    createCone: (input: ConeInput) =>
      log("createCone", () => kernel.createCone(input)),
    extrude: (input: ProfileExtrudeInput) =>
      log("extrude", () => kernel.extrude(input)),
    revolve: (input: ProfileRevolveInput) =>
      log("revolve", () => kernel.revolve(input)),
    sweep: (input: ProfileSweepInput) =>
      log("sweep", () => kernel.sweep(input)),
    loft: (input: ProfileLoftInput) => log("loft", () => kernel.loft(input)),
    fillet: (input: FilletInput) => log("fillet", () => kernel.fillet(input)),
    chamfer: (input: ChamferInput) =>
      log("chamfer", () => kernel.chamfer(input)),
    shell: (input: ShellInput) => log("shell", () => kernel.shell(input)),
    union: (operands: readonly KernelSolid[]) =>
      log("union", () => kernel.union(operands)),
    subtract: (target: KernelSolid, tools: readonly KernelSolid[]) =>
      log("subtract", () => kernel.subtract(target, tools)),
    intersect: (operands: readonly KernelSolid[]) =>
      log("intersect", () => kernel.intersect(operands)),
    transform: (solid: KernelSolid, input: TransformInput) =>
      log("transform", () => kernel.transform(solid, input)),
    mirror: (solid: KernelSolid, input: MirrorInput) =>
      log("mirror", () => kernel.mirror(solid, input)),
    bounds: (solid: KernelSolid) => log("bounds", () => kernel.bounds(solid)),
    volume: (solid: KernelSolid) => log("volume", () => kernel.volume(solid)),
    area: (solid: KernelSolid) => log("area", () => kernel.area(solid)),
    tessellate: (solid: KernelSolid) =>
      log("tessellate", () => kernel.tessellate(solid)),
    dispose: (solid: KernelSolid) => kernel.dispose(solid),
    get operations() {
      return operations;
    },
  };
}

/** What the example reports back to the guide and the docs page. */
export interface CustomAdapterExampleSummary {
  readonly backendId: string;
  readonly boxVolumeMm3: number;
  readonly operations: readonly string[];
}

/**
 * Runs one box-and-measure chain through the logged wrapper and reports
 * the recorded operations — the adapter's delegation at work.
 */
export function runCustomAdapterExample(): CustomAdapterExampleSummary {
  const kernel = withOperationLog(createFakeKernel());
  const box = kernel.createBox({
    width: { dimension: "length", unit: "mm", value: 10 },
    depth: { dimension: "length", unit: "mm", value: 10 },
    height: { dimension: "length", unit: "mm", value: 10 },
  });
  if (!box.ok) {
    throw new Error(`The wrapped kernel refused a box: ${box.error.message}`);
  }
  const volume = kernel.volume(box.value);
  if (!volume.ok) {
    throw new Error(
      `The wrapped kernel refused a measurement: ${volume.error.message}`,
    );
  }
  return {
    backendId: kernel.id,
    boxVolumeMm3: volume.value,
    operations: kernel.operations,
  };
}

/** Exported for the contract-suite example: the wrapped fake kernel. */
export function createLoggedFakeKernel(): LoggedKernel {
  return withOperationLog(createFakeKernel());
}
