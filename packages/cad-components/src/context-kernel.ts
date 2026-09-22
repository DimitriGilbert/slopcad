/**
 * The component execution surface over the worker protocol (Phase 32):
 * runs a component's kernel calls across a `ComputationContext` — the
 * stale-result-coordinated client every browser fixture and the workbench
 * dispatch through — so a component builds in a page exactly as it builds
 * in tests, with the real kernel worker carrying the geometry.
 *
 * Every {@link ComponentKernel} call maps onto the versioned `solid.*`
 * operation vocabulary the worker protocol carries (see
 * `@slopcad/cad-kernel`'s `WORKER_OPERATION_IDS`); the contract's
 * structured failures ride back inside `worker/operation-failed`
 * responses with their `kernel/*` code in `data.kernelCode`, which this
 * adapter recovers verbatim. The two contract operations the protocol
 * vocabulary does not carry (`sweep`, `loft`) answer with the structured
 * `kernel/unsupported-operation` — the honest refusal, never an
 * approximation.
 *
 * Solid handles are minted through `createSolidTag` (the documented mint
 * for kernel adapters in separate packages) with the worker's `wsol_` id
 * as the payload — handles stay opaque to component code, and ownership
 * stays with this kernel instance.
 *
 * Capabilities: absent a capability query in the protocol, the adapter
 * declares what the PROTOCOL can carry (every mapped operation, minus the
 * vocabulary-absent sweep/loft and the ownership-scoped persistent
 * topology). Pass `capabilities` when the remote backend's declarations
 * are known; per-operation refusals surface as structured kernel errors
 * either way.
 */

import type {
  BoxInput,
  ChamferInput,
  ComputationContext,
  ConeInput,
  CylinderInput,
  FilletInput,
  KernelCapabilities,
  KernelSolid,
  MirrorInput,
  ProfileExtrudeInput,
  ProfileRevolveInput,
  ShellInput,
  SphereInput,
  TransformInput,
  WorkerSolidId,
} from "@slopcad/cad-kernel";
import { KERNEL_ERROR_CODES, WorkerRequestFailure } from "@slopcad/cad-kernel";
import { createSolidTag } from "@slopcad/cad-kernel/opaque";
import { fail, ok } from "@slopcad/cad-core";
import type {
  ComponentKernel,
  ComponentKernelResult,
} from "./component-kernel";

/** The adapter's declared capabilities: what the protocol vocabulary carries. */
const CONTEXT_KERNEL_CAPABILITIES: KernelCapabilities = Object.freeze({
  booleans: true,
  transformTranslation: true,
  transformRotation: true,
  transformScale: false,
  exactPrimitiveVolumes: false,
  exactBooleanVolumes: false,
  tightBooleanBounds: false,
  persistentTopology: false,
  sweep: false,
  helix: false,
  loft: false,
  fillet: true,
  chamfer: true,
  thicken: false,
  extrudeTaper: false,
  shell: true,
  mirror: true,
  surfaceArea: true,
});

/**
 * Recovers a structured kernel error from a failed worker request: the
 * kernel's own code rides `data.kernelCode` (the worker server's documented
 * cause channel); protocol-level failures (cancellation, transport) keep
 * their `worker/*` codes verbatim. Nothing throws.
 */
function failureOf(error: unknown): ComponentKernelResult<never> {
  if (error instanceof WorkerRequestFailure) {
    const data = error.error.data;
    const kernelCode = data?.kernelCode;
    return fail({
      code: typeof kernelCode === "string" ? kernelCode : error.error.code,
      input: error.error.data,
      message: error.message,
    });
  }
  return fail({
    code: "worker/transport-failed",
    input: null,
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * Runs `call` against the context, normalizing a `WorkerRequestFailure`
 * rejection into the structured kernel-error shape. The context's own
 * request result is already a plain payload (kernel semantic failures
 * REJECT at the protocol layer with `worker/operation-failed`).
 */
async function request<R>(
  call: () => Promise<R>,
): Promise<ComponentKernelResult<R>> {
  try {
    return ok(await call());
  } catch (error) {
    return failureOf(error);
  }
}

export interface ContextKernelOptions {
  /**
   * The remote kernel's declared capabilities, when the consumer knows
   * them; defaults to the protocol-carrier set documented on this module.
   */
  readonly capabilities?: KernelCapabilities;
}

/**
 * Creates a component kernel that executes every call over `context` —
 * the computation context one browser computation runs against (the
 * stale-result coordinator stamps each request with the computation's
 * revision and releases the session solids it mints). Dispose participates
 * in the same channel, so the coordinator's bookkeeping stays exact.
 */
export function createContextKernel(
  context: ComputationContext,
  options: ContextKernelOptions = {},
): ComponentKernel {
  // The payload behind the adapter's solid handles is the worker's solid
  // id, wrapped in a tag this instance owns. Handles are owned per kernel
  // instance (the ownership model `opaque.ts` documents, and the convention
  // of every other adapter): each `createContextKernel` call mints its own
  // tag, so a handle from a sibling context kernel trips the local
  // "did not mint" guard below instead of reaching the remote worker.
  const tag = createSolidTag<WorkerSolidId>();
  const wrapWorkerSolid = (id: WorkerSolidId): KernelSolid => tag.wrap(id);
  const workerSolidId = (solid: KernelSolid): WorkerSolidId => {
    const id = tag.unwrap(solid);
    if (id === undefined) {
      throw new Error(
        "The context kernel rejected a solid handle it did not mint.",
      );
    }
    return id;
  };
  const unsupported = (operation: string): ComponentKernelResult<never> =>
    fail({
      code: KERNEL_ERROR_CODES.unsupportedOperation,
      input: operation,
      message: `The worker protocol vocabulary carries no ${operation} operation, so the context kernel cannot execute it.`,
    });

  const solidResult = (
    call: Promise<{ readonly solid: WorkerSolidId }>,
  ): Promise<ComponentKernelResult<KernelSolid>> =>
    request(async () => wrapWorkerSolid((await call).solid));

  return {
    capabilities: options.capabilities ?? CONTEXT_KERNEL_CAPABILITIES,

    async createBox(input: BoxInput) {
      return solidResult(
        context.request("solid.createBox", {
          depth: input.depth,
          height: input.height,
          width: input.width,
        }),
      );
    },

    async createSphere(input: SphereInput) {
      return solidResult(
        context.request("solid.createSphere", { radius: input.radius }),
      );
    },

    async createCylinder(input: CylinderInput) {
      return solidResult(
        context.request("solid.createCylinder", {
          height: input.height,
          radius: input.radius,
        }),
      );
    },

    async createCone(input: ConeInput) {
      return solidResult(
        context.request("solid.createCone", {
          bottomRadius: input.bottomRadius,
          height: input.height,
          topRadius: input.topRadius,
        }),
      );
    },

    async extrude(input: ProfileExtrudeInput) {
      return solidResult(
        context.request("solid.extrude", {
          direction: input.direction,
          height: input.height,
          loop: input.loop,
          placement: input.placement,
        }),
      );
    },

    async revolve(input: ProfileRevolveInput) {
      return solidResult(
        context.request("solid.revolve", {
          angle: input.angle,
          axis: input.axis,
          loop: input.loop,
          placement: input.placement,
        }),
      );
    },

    sweep: () => Promise.resolve(unsupported("sweep")),

    loft: () => Promise.resolve(unsupported("loft")),

    async fillet(input: FilletInput) {
      return solidResult(
        context.request("solid.fillet", {
          edges: input.edges,
          radius: input.radius,
          target: workerSolidId(input.target),
        }),
      );
    },

    async chamfer(input: ChamferInput) {
      return solidResult(
        context.request("solid.chamfer", {
          distance: input.distance,
          edges: input.edges,
          target: workerSolidId(input.target),
        }),
      );
    },

    async shell(input: ShellInput) {
      return solidResult(
        context.request("solid.shell", {
          faces: input.faces,
          target: workerSolidId(input.target),
          thickness: input.thickness,
        }),
      );
    },

    async mirror(solid: KernelSolid, input: MirrorInput) {
      return solidResult(
        context.request("solid.mirror", {
          axis: input.axis,
          offset: input.offset,
          target: workerSolidId(solid),
        }),
      );
    },

    async union(operands) {
      return solidResult(
        context.request("solid.union", {
          operands: operands.map(workerSolidId),
        }),
      );
    },

    async subtract(target, tools) {
      return solidResult(
        context.request("solid.subtract", {
          target: workerSolidId(target),
          tools: tools.map(workerSolidId),
        }),
      );
    },

    async intersect(operands) {
      return solidResult(
        context.request("solid.intersect", {
          operands: operands.map(workerSolidId),
        }),
      );
    },

    async transform(solid: KernelSolid, input: TransformInput) {
      return solidResult(
        context.request("solid.transform", {
          solid: workerSolidId(solid),
          ...(input.rotation !== undefined ? { rotation: input.rotation } : {}),
          translation: { x: input.x, y: input.y, z: input.z },
        }),
      );
    },

    async bounds(solid) {
      return request(async () => {
        const applied = await context.request("solid.bounds", {
          solid: workerSolidId(solid),
        });
        return applied.bounds;
      });
    },

    async volume(solid) {
      return request(async () => {
        const applied = await context.request("solid.volume", {
          solid: workerSolidId(solid),
        });
        return applied.volume;
      });
    },

    async area(solid) {
      return request(async () => {
        const applied = await context.request("solid.area", {
          solid: workerSolidId(solid),
        });
        return applied.area;
      });
    },

    async tessellate(solid) {
      return request(async () => {
        const applied = await context.request("solid.tessellate", {
          solid: workerSolidId(solid),
        });
        return applied.tessellation;
      });
    },

    async dispose(solid) {
      await context.request("solid.dispose", { solid: workerSolidId(solid) });
    },
  };
}
