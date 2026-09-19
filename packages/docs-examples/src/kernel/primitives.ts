/**
 * The `primitives` and `booleans` guides' runnable example
 * (docs/guides/primitives.md, docs/guides/booleans.md): the kernel
 * contract's producer surface — primitives (box, sphere, cylinder, cone),
 * measurements (volume, bounds, area), the boolean trio (union,
 * subtract, intersect), and the structured-failure discipline
 * (`kernel/unsupported-operation`, `kernel/invalid-length`) — run against
 * a real kernel instance the caller supplies, so the same example proves
 * the fake kernel (dependency-free) and the Manifold kernel (real WASM
 * geometry) alike.
 */

import { createBodyId, length, type BodyId } from "@slopcad/cad-core";
import {
  KERNEL_ERROR_CODES,
  type GeometryKernel,
  type KernelSolid,
  type Tessellation,
} from "@slopcad/cad-kernel";

/** The example's plate body id (the projection example's body). */
export const KERNEL_PLATE_BODY: BodyId = createBodyId("body_guide_plate");

/** What the example reports back to the guide and the docs page. */
export interface KernelExampleSummary {
  readonly backendId: string;
  readonly boxVolumeMm3: number;
  readonly boxSurfaceAreaMm2: number;
  readonly sphereVolumeMm3: number;
  readonly cylinderVolumeMm3: number;
  readonly coneVolumeMm3: number;
  readonly unionVolumeMm3: number;
  readonly subtractVolumeMm3: number;
  readonly intersectVolumeMm3: number;
  readonly boxTriangleCount: number;
  readonly negativeRadiusCode: string;
  readonly tessellation: Tessellation;
}

/**
 * Runs the primitive/boolean tour against `kernel` and reports the
 * measured facts. Volumes are the kernel's own measurements — analytic
 * for the fake kernel's primitives, exact for Manifold's mesh volumes.
 */
export function runKernelExample(kernel: GeometryKernel): KernelExampleSummary {
  // Primitives.
  const box = unwrapKernel(
    kernel.createBox({
      width: length(30),
      depth: length(20),
      height: length(10),
    }),
    "createBox",
  );
  const sphere = unwrapKernel(
    kernel.createSphere({ radius: length(5) }),
    "createSphere",
  );
  const cylinder = unwrapKernel(
    kernel.createCylinder({ radius: length(4), height: length(10) }),
    "createCylinder",
  );
  const cone = unwrapKernel(
    kernel.createCone({
      bottomRadius: length(4),
      topRadius: length(0),
      height: length(10),
    }),
    "createCone",
  );

  // Measurements.
  const boxVolume = unwrapKernel(kernel.volume(box), "box volume");
  const boxArea = unwrapKernel(kernel.area(box), "box area");
  const sphereVolume = unwrapKernel(kernel.volume(sphere), "sphere volume");
  const cylinderVolume = unwrapKernel(
    kernel.volume(cylinder),
    "cylinder volume",
  );
  const coneVolume = unwrapKernel(kernel.volume(cone), "cone volume");

  // Booleans: union of two half-overlapping boxes, a subtract cut, an
  // intersect overlap (the boxes share x ∈ [15, 30]: 15 × 20 × 10 mm³).
  const boxFar = unwrapKernel(
    kernel.transform(box, {
      x: length(15),
      y: length(0),
      z: length(0),
    }),
    "translated box",
  );
  const union = unwrapKernel(kernel.union([box, boxFar]), "union");
  const cutter = unwrapKernel(
    kernel.createCylinder({ radius: length(4), height: length(10) }),
    "cutter",
  );
  const subtracted = unwrapKernel(kernel.subtract(box, [cutter]), "subtract");
  const overlapped = unwrapKernel(kernel.intersect([box, boxFar]), "intersect");
  const unionVolume = unwrapKernel(kernel.volume(union), "union volume");
  const subtractVolume = unwrapKernel(
    kernel.volume(subtracted),
    "subtract volume",
  );
  const intersectVolume = unwrapKernel(
    kernel.volume(overlapped),
    "intersect volume",
  );

  // Tessellation (deterministic, valid, indexed triangle soup).
  const tessellation = unwrapKernel(kernel.tessellate(box), "box tessellation");

  // The structured-failure discipline: invalid input fails with a stable
  // code, never a throw.
  const rejected = kernel.createBox({
    width: length(-1),
    depth: length(1),
    height: length(1),
  });

  // Hygiene: the contract's dispose never fails.
  kernel.dispose(union);
  kernel.dispose(overlapped);

  return {
    backendId: kernel.id,
    boxVolumeMm3: boxVolume,
    boxSurfaceAreaMm2: boxArea,
    sphereVolumeMm3: sphereVolume,
    cylinderVolumeMm3: cylinderVolume,
    coneVolumeMm3: coneVolume,
    unionVolumeMm3: unionVolume,
    subtractVolumeMm3: subtractVolume,
    intersectVolumeMm3: intersectVolume,
    boxTriangleCount: tessellation.indices.length / 3,
    negativeRadiusCode: rejected.ok
      ? "unexpectedly accepted"
      : rejected.error.code,
    tessellation,
  };
}

/** Unwraps a `KernelResult`, naming the operation for the error message. */
export function unwrapKernel<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | {
        readonly ok: false;
        readonly error: { readonly code: string; readonly message: string };
      },
  operation: string,
): T {
  if (!result.ok) {
    throw new Error(
      `${operation} failed (${result.error.code}): ${result.error.message}`,
    );
  }
  return result.value;
}

/** The kernel error code the guides cite for unsupported operations. */
export const UNSUPPORTED_OPERATION_CODE =
  KERNEL_ERROR_CODES.unsupportedOperation;

/** A solid reference for consumers that want the example's handles. */
export type ExampleSolid = KernelSolid;
