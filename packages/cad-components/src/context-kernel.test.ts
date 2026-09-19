/**
 * Context-kernel tests (Phase 32): the worker-protocol adapter runs a
 * component's build across a REAL worker channel (an in-memory session
 * hosting the Manifold kernel — the same protocol a browser worker
 * speaks, per the stale-result coordinator), producing the same
 * structured results and the same geometry the direct in-process kernel
 * produces. The honest refusals (sweep/loft absent from the protocol
 * vocabulary) and the kernel-code recovery path are pinned.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  assertBoundsEqual,
  assertVolumeClose,
  createInMemoryKernelSession,
  createStaleResultCoordinator,
  KERNEL_ERROR_CODES,
} from "@slopcad/cad-kernel";
import { CURVED_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";
import { createManifoldKernel } from "@slopcad/cad-kernel-manifold";
import type { ComponentKernelResult } from "./component-kernel";
import type {
  GeometryKernel,
  KernelBounds,
  KernelSolid,
  StaleResultCoordinator,
  WorkerClient,
} from "@slopcad/cad-kernel";
import type { ComponentBuild } from "./cad-component";

import { directComponentKernel } from "./component-kernel";
import { createContextKernel } from "./context-kernel";
import { nema17Mount, NEMA17_MOUNT_DEFAULT_PARAMETERS } from "./nema17-mount";
import { nema17Analytic } from "./component-fixtures";

/** One booted in-memory session: channel client, typed coordinator, kernel. */
interface Session<S> {
  readonly client: WorkerClient;
  readonly coordinator: StaleResultCoordinator<S>;
  readonly kernel: GeometryKernel;
}

async function bootSession<S>(): Promise<Session<S>> {
  const kernel = await createManifoldKernel();
  const session = createInMemoryKernelSession(kernel);
  return {
    client: session.client,
    coordinator: createStaleResultCoordinator<S>({
      client: session.client,
    }),
    kernel,
  };
}

describe("createContextKernel over the worker protocol", () => {
  it("builds the NEMA 17 mount across the channel with direct-kernel-identical geometry", async () => {
    interface ChannelResult {
      readonly volumeMm3: number;
      readonly bounds: KernelBounds;
    }
    interface ChannelOutcome {
      readonly ok: true;
      readonly value: {
        readonly build: ComponentBuild;
        readonly measured: readonly ChannelResult[];
      };
    }
    const { client, coordinator, kernel } = await bootSession<ChannelOutcome>();
    try {
      const outcome = await coordinator.update(async (context) => {
        const adapter = createContextKernel(context);
        const build = await nema17Mount.build(
          adapter,
          NEMA17_MOUNT_DEFAULT_PARAMETERS,
        );
        if (!build.ok) throw new Error(build.error.message);
        // Measure THROUGH the context kernel too: the whole round trip is
        // the protocol's, not just the construction.
        const measured: ChannelResult[] = [];
        for (const body of build.value.bodies) {
          const volume = await adapter.volume(body.solid);
          const bounds = await adapter.bounds(body.solid);
          if (!volume.ok || !bounds.ok) {
            throw new Error("measurement refused");
          }
          measured.push({
            bounds: bounds.value,
            volumeMm3: volume.value,
          });
        }
        return { ok: true, value: { build: build.value, measured } };
      });
      expect(outcome.outcome).toBe("applied");
      if (outcome.outcome !== "applied") return;
      expect(outcome.result.ok).toBe(true);

      const analytic = nema17Analytic(NEMA17_MOUNT_DEFAULT_PARAMETERS);
      const body = outcome.result.value.measured[0];
      expect(body).toBeDefined();
      if (body === undefined) return;
      assertVolumeClose(
        body.volumeMm3,
        analytic.volumeMm3,
        CURVED_VOLUME_TOLERANCE,
      );
      assertBoundsEqual(body.bounds, analytic.bounds);

      // The direct in-process kernel computes the same volume (channel
      // transparency: bytes identical, transport different).
      const direct = directComponentKernel(kernel);
      const directBuild = await nema17Mount.build(
        direct,
        NEMA17_MOUNT_DEFAULT_PARAMETERS,
      );
      expect(directBuild.ok).toBe(true);
      if (!directBuild.ok) return;
      const directVolume = await direct.volume(
        directBuild.value.bodies[0]!.solid,
      );
      expect(directVolume.ok).toBe(true);
      if (directVolume.ok) {
        expect(body.volumeMm3).toBe(directVolume.value);
      }
    } finally {
      client.close();
    }
  });

  it("recovers the kernel's own failure code from a refused operation", async () => {
    const { client, coordinator } =
      await bootSession<ComponentKernelResult<KernelSolid>>();
    try {
      const outcome = await coordinator.update((context) =>
        createContextKernel(context).createCylinder({
          height: length(10),
          radius: length(-3),
        }),
      );
      expect(outcome.outcome).toBe("applied");
      if (outcome.outcome !== "applied") return;
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) {
        expect(outcome.result.error.code).toBe(
          KERNEL_ERROR_CODES.invalidLength,
        );
      }
    } finally {
      client.close();
    }
  });

  it("refuses sweep and loft honestly (absent from the protocol vocabulary)", async () => {
    const { client, coordinator } =
      await bootSession<ComponentKernelResult<KernelSolid>>();
    try {
      const outcome = await coordinator.update((context) =>
        createContextKernel(context).sweep({
          loop: [
            { end: [1, 0], kind: "line", start: [0, 0] },
            { end: [1, 1], kind: "line", start: [1, 0] },
            { end: [0, 1], kind: "line", start: [1, 1] },
            { end: [0, 0], kind: "line", start: [0, 1] },
          ],
          path: [{ kind: "line", start: [0, 0], end: [5, 0] }],
          placement: {
            rotation: { axis: [0, 0, 1], angle: angle(0) },
            translation: { x: length(0), y: length(0), z: length(0) },
          },
        }),
      );
      expect(outcome.outcome).toBe("applied");
      if (outcome.outcome !== "applied") return;
      expect(outcome.result.ok).toBe(false);
      if (!outcome.result.ok) {
        expect(outcome.result.error.code).toBe(
          KERNEL_ERROR_CODES.unsupportedOperation,
        );
        expect(outcome.result.error.message).toContain("sweep");
      }
    } finally {
      client.close();
    }
  });

  it("declares the protocol-carrier capabilities by default and honors an override", async () => {
    interface CapabilitiesView {
      readonly defaultCapabilities: Readonly<Record<string, unknown>>;
      readonly overriddenSweep: boolean;
    }
    const { client, coordinator } = await bootSession<CapabilitiesView>();
    try {
      const outcome = await coordinator.update((context) =>
        Promise.resolve({
          defaultCapabilities: {
            ...createContextKernel(context).capabilities,
          },
          overriddenSweep: createContextKernel(context, {
            capabilities: {
              ...createContextKernel(context).capabilities,
              sweep: true,
            },
          }).capabilities.sweep,
        }),
      );
      expect(outcome.outcome).toBe("applied");
      if (outcome.outcome !== "applied") return;
      expect(outcome.result.defaultCapabilities.booleans).toBe(true);
      expect(outcome.result.defaultCapabilities.transformScale).toBe(false);
      expect(outcome.result.defaultCapabilities.sweep).toBe(false);
      expect(outcome.result.defaultCapabilities.loft).toBe(false);
      expect(outcome.result.overriddenSweep).toBe(true);
    } finally {
      client.close();
    }
  });
});
