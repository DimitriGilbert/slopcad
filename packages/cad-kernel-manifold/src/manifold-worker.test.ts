/**
 * Real-worker integration tests (Phase 10.3): the full operation matrix —
 * primitives, booleans, the transform, measurements, tessellation, the
 * disposal lifecycle — executed by the REAL Manifold kernel inside a REAL
 * `node:worker_threads` thread, reached only through the worker protocol
 * over the node transport adapter.
 *
 * Everything Phases 10.1/10.2 pinned in-memory is here demanded of the
 * actual channel: results cross a structured clone and arrive kernel-neutral
 * (plain solid ids, numbers, arrays), kernel failures reach the caller as
 * structured worker errors carrying the kernel code, the cancellation
 * windows that are observable on a real channel behave as pinned, and the
 * same request sequence over fresh workers is bit-for-bit deterministic.
 *
 * Cancellation observability note: with a synchronous kernel hosted behind
 * the server's non-reentrant message loop, a cancel message that arrives
 * after its request is always processed after that request's execution
 * finished (microtasks drain between message deliveries), so the
 * "cancelled while running" window cannot be observed deterministically on
 * a real channel — the client-side void and the server-side pre-arrival
 * window below are the honest observable windows, and both are exercised.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import {
  KERNEL_ERROR_CODES,
  WORKER_PROTOCOL_ERROR_CODES,
  WorkerRequestFailure,
  createWorkerCancel,
  createWorkerRequestId,
} from "@slopcad/cad-kernel";
import type { WorkerClient, WorkerSolidId } from "@slopcad/cad-kernel";
import { CURVED_VOLUME_TOLERANCE } from "@slopcad/cad-kernel/contract-suite";
import type { NodeManifoldWorkerChannel } from "./node-manifold-worker";

import { BOOLEAN_CHAIN } from "./manifold-fixtures";
import { createNodeManifoldWorkerChannel } from "./node-manifold-worker";

const mm = (value: number) => length(value, "mm");

let channel: NodeManifoldWorkerChannel;
let client: WorkerClient;

// Channel creation is synchronous: requests posted before the worker's
// WASM runtime finishes booting buffer on the port and are answered once
// the server subscribes, so no readiness handshake is needed.
beforeAll(() => {
  channel = createNodeManifoldWorkerChannel();
  client = channel.client;
});

afterAll(async () => {
  await channel.close();
});

async function createBox(
  width: number,
  depth: number,
  height: number,
): Promise<WorkerSolidId> {
  const box = await client.request("solid.createBox", {
    width: mm(width),
    depth: mm(depth),
    height: mm(height),
  });
  return box.solid;
}

/**
 * The Phase 9 boolean-chain scene, rebuilt through worker requests: two
 * disjoint blocks unioned, a bore drilled through the left block, the right
 * block dropped by an intersect — exercising primitives, the transform,
 * every boolean, and the measurements along the way.
 */
async function buildChainScene(): Promise<{
  readonly union: WorkerSolidId;
  readonly cut: WorkerSolidId;
  readonly trimmed: WorkerSolidId;
}> {
  const { blockEdgeMm, blockOffsetMm, boreRadiusMm, clipWidthMm } =
    BOOLEAN_CHAIN;
  const left = await createBox(blockEdgeMm, blockEdgeMm, blockEdgeMm);
  const rightBox = await createBox(blockEdgeMm, blockEdgeMm, blockEdgeMm);
  const right = await client.request("solid.transform", {
    solid: rightBox,
    translation: { x: mm(blockOffsetMm), y: mm(0), z: mm(0) },
  });
  const union = await client.request("solid.union", {
    operands: [left, right.solid],
  });
  const boreCylinder = await client.request("solid.createCylinder", {
    radius: mm(boreRadiusMm),
    height: mm(blockEdgeMm),
  });
  const bore = await client.request("solid.transform", {
    solid: boreCylinder.solid,
    translation: {
      x: mm(blockEdgeMm / 2),
      y: mm(blockEdgeMm / 2),
      z: mm(0),
    },
  });
  const cut = await client.request("solid.subtract", {
    target: union.solid,
    tools: [bore.solid],
  });
  const clip = await createBox(clipWidthMm, blockEdgeMm, blockEdgeMm);
  const trimmed = await client.request("solid.intersect", {
    operands: [cut.solid, clip],
  });
  return { union: union.solid, cut: cut.solid, trimmed: trimmed.solid };
}

describe("the manifold worker over a real node worker channel", () => {
  it(
    "executes the full operation matrix with kernel-neutral results",
    async () => {
      const { blockEdgeMm, boreRadiusMm } = BOOLEAN_CHAIN;
      const scene = await buildChainScene();

      // Measurement of a boolean union: axis-aligned, so exact (two 10³
      // blocks).
      const unionVolume = await client.request("solid.volume", {
        solid: scene.union,
      });
      expect(unionVolume.volume).toBeCloseTo(2 * blockEdgeMm ** 3, 9);

      // Measurement of a drilled, trimmed boolean: curved bore, so within
      // the curved tolerance of the analytic value.
      const trimmedVolume = await client.request("solid.volume", {
        solid: scene.trimmed,
      });
      const analytic =
        blockEdgeMm ** 3 - Math.PI * boreRadiusMm ** 2 * blockEdgeMm;
      expect(
        Math.abs(trimmedVolume.volume - analytic) / analytic,
      ).toBeLessThan(CURVED_VOLUME_TOLERANCE);

      // Tight bounds of the trimmed result: every face lies on the clip or
      // block faces, so exact.
      const trimmedBounds = await client.request("solid.bounds", {
        solid: scene.trimmed,
      });
      expect(trimmedBounds.bounds).toEqual({
        min: [0, 0, 0],
        max: [blockEdgeMm, blockEdgeMm, blockEdgeMm],
      });

      // Tessellation crosses as plain arrays with kernel-computed unit
      // normals paired index-for-index with the positions.
      const { tessellation } = await client.request("solid.tessellate", {
        solid: scene.trimmed,
      });
      expect(tessellation.indices.length).toBeGreaterThan(0);
      expect(tessellation.normals).toBeDefined();
      const { positions, normals } = tessellation;
      if (normals === undefined) throw new Error("normals must be present");
      expect(normals.length).toBe(positions.length);
      for (let vertex = 0; vertex < normals.length; vertex += 3) {
        const magnitude = Math.hypot(
          normals[vertex] ?? Number.NaN,
          normals[vertex + 1] ?? Number.NaN,
          normals[vertex + 2] ?? Number.NaN,
        );
        expect(magnitude).toBeCloseTo(1, 6);
      }
    },
    60_000,
  );

  it(
    "runs the disposal lifecycle: dispose resolves null, and use-after-dispose fails with the kernel's solid-not-owned code",
    async () => {
      const box = await createBox(1, 1, 1);
      const disposed = await client.request("solid.dispose", { solid: box });
      expect(disposed).toBeNull();

      await expect(client.request("solid.volume", { solid: box })).rejects.toMatchObject(
        {
          name: "WorkerRequestFailure",
          error: {
            code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
            data: { kernelCode: KERNEL_ERROR_CODES.solidNotOwned },
          },
        },
      );
      // The channel stays healthy after a structured failure.
      const sphere = await client.request("solid.createSphere", {
        radius: mm(1),
      });
      expect(typeof sphere.solid).toBe("string");
    },
    60_000,
  );

  it(
    "carries kernel validation failures over the wire as structured operation failures with the kernel code",
    async () => {
      // Invalid primitive lengths are rejected by the kernel inside the
      // worker and reach the caller as worker/operation-failed with the
      // kernel's invalid-length code.
      await expect(
        client.request("solid.createBox", {
          width: mm(0),
          depth: mm(1),
          height: mm(1),
        }),
      ).rejects.toMatchObject({
        error: {
          code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
          data: { kernelCode: KERNEL_ERROR_CODES.invalidLength },
        },
      });

      // A boolean with too few operands is the kernel's invalid-operands.
      const box = await createBox(2, 2, 2);
      await expect(
        client.request("solid.union", { operands: [box] }),
      ).rejects.toMatchObject({
        error: {
          code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
          data: { kernelCode: KERNEL_ERROR_CODES.invalidOperands },
        },
      });
    },
    60_000,
  );

  describe("cancellation over the real channel", () => {
    it(
      "voids a request the moment the caller cancels it, without damaging the channel",
      async () => {
        const id = createWorkerRequestId("req_caller-voided");
        const pending = client.request(
          "solid.createBox",
          {
            width: mm(2),
            depth: mm(2),
            height: mm(2),
          },
          id,
        );
        // Attach the rejection handler before voiding, so the synchronous
        // settlement never observes an unhandled rejection.
        const settled = expect(pending).rejects.toMatchObject({
          error: { code: WORKER_PROTOCOL_ERROR_CODES.cancelled },
        });

        client.cancel(id);

        await settled;
        // The worker is still fully usable — the void request left no damage,
        // whatever became of it responder-side.
        const after = await client.request("solid.createSphere", {
          radius: mm(1),
        });
        expect(typeof after.solid).toBe("string");
      },
      60_000,
    );

    it(
      "acknowledges a cancel that overtook its request (the server-side pre-arrival window)",
      async () => {
        const id = createWorkerRequestId("req_pre-arrival-cancel");
        // Raw wire injection: the cancel reaches the responder first and is
        // recorded before the request bearing the same id arrives — the one
        // server-side cancellation window observable deterministically on a
        // real channel.
        channel.transport.send(createWorkerCancel(id));

        const failure = await client
          .request("solid.createSphere", { radius: mm(1) }, id)
          .then(
            () => {
              throw new Error("The pre-cancelled request must not succeed.");
            },
            (error: unknown) => error,
          );

        expect(failure).toBeInstanceOf(WorkerRequestFailure);
        if (!(failure instanceof WorkerRequestFailure)) {
          throw new Error("Expected a WorkerRequestFailure.");
        }
        expect(failure.error.code).toBe(WORKER_PROTOCOL_ERROR_CODES.cancelled);
        // This acknowledgement came from the responder ("before the request
        // arrived"), not from the client's own cancel path.
        expect(failure.error.message).toContain("before the request arrived");
      },
      60_000,
    );

    it(
      "is a no-op to cancel an already-settled request, which cannot be unsettled",
      async () => {
        const id = createWorkerRequestId("req_settled-cancel");
        const box = await client.request(
          "solid.createBox",
          { width: mm(1), depth: mm(1), height: mm(1) },
          id,
        );

        client.cancel(id);

        const volume = await client.request("solid.volume", {
          solid: box.solid,
        });
        expect(volume.volume).toBeCloseTo(1, 9);
      },
      60_000,
    );
  });

  it(
    "produces identical results for identical sequences over fresh workers",
    async () => {
      const runScene = async (): Promise<{
        readonly solids: readonly WorkerSolidId[];
        readonly volume: number;
        readonly bounds: unknown;
        readonly positions: readonly number[];
        readonly indices: readonly number[];
        readonly normals: readonly number[];
      }> => {
        const fresh = createNodeManifoldWorkerChannel();
        try {
          const solids: WorkerSolidId[] = [];
          const plate = await fresh.client.request("solid.createBox", {
            width: mm(30),
            depth: mm(20),
            height: mm(10),
          });
          solids.push(plate.solid);
          const boreAtOrigin = await fresh.client.request(
            "solid.createCylinder",
            { radius: mm(4), height: mm(10) },
          );
          solids.push(boreAtOrigin.solid);
          const bore = await fresh.client.request("solid.transform", {
            solid: boreAtOrigin.solid,
            translation: { x: mm(15), y: mm(10), z: mm(0) },
          });
          solids.push(bore.solid);
          const result = await fresh.client.request("solid.subtract", {
            target: plate.solid,
            tools: [bore.solid],
          });
          solids.push(result.solid);
          const volume = await fresh.client.request("solid.volume", {
            solid: result.solid,
          });
          const bounds = await fresh.client.request("solid.bounds", {
            solid: result.solid,
          });
          const tessellated = await fresh.client.request("solid.tessellate", {
            solid: result.solid,
          });
          const tessellation = tessellated.tessellation;
          if (tessellation.normals === undefined) {
            throw new Error("The drilled plate must carry kernel normals.");
          }
          return {
            solids,
            volume: volume.volume,
            bounds: bounds.bounds,
            positions: tessellation.positions,
            indices: tessellation.indices,
            normals: tessellation.normals,
          };
        } finally {
          await fresh.close();
        }
      };

      const first = await runScene();
      const second = await runScene();

      // Deterministic id minting: the same sequence over a fresh session
      // assigns the same solid ids, in delivery order.
      expect(second.solids).toEqual(first.solids);
      // The engine is single-threaded and input-deterministic: identical
      // scenes produce bit-identical numbers and meshes.
      expect(second.volume).toBe(first.volume);
      const analyticPlateVolume = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;
      expect(
        Math.abs(second.volume - analyticPlateVolume) / analyticPlateVolume,
      ).toBeLessThan(CURVED_VOLUME_TOLERANCE);
      expect(second.bounds).toEqual(first.bounds);
      expect(second.positions).toEqual(first.positions);
      expect(second.indices).toEqual(first.indices);
      expect(second.normals).toEqual(first.normals);
    },
    60_000,
  );
});
