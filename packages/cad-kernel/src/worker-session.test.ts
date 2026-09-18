/**
 * The in-memory kernel session (Phase 10.2): the whole stack — fake kernel,
 * server, in-memory transport, client — exercised end to end from the domain
 * caller's seat. This is the plan's settled-architecture landing: the engine
 * hosted behind the worker protocol, callable in-process, with the same
 * request sequence producing identical results and identical id assignment
 * over a fresh pair.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";

import { tessellationTriangleCount } from "./contract";
import { createFakeKernel, FAKE_BOX_TRIANGLE_COUNT } from "./fake-kernel";
import { WorkerRequestFailure } from "./worker-client";
import { createWorkerRequestId, createWorkerSolidId } from "./worker-ids";
import { createInMemoryKernelSession } from "./worker-session";

const mm = (value: number) => length(value, "mm");

function failureOf(promise: Promise<unknown>): Promise<WorkerRequestFailure> {
  return promise.then(
    () => {
      throw new Error("Expected the request to fail.");
    },
    (error: unknown) => {
      if (!(error instanceof WorkerRequestFailure)) {
        throw new Error(
          `Expected a WorkerRequestFailure, received ${String(error)}.`,
        );
      }
      return error;
    },
  );
}

function newSession() {
  return createInMemoryKernelSession(createFakeKernel()).client;
}

describe("session round-trip against the fake kernel", () => {
  it("runs primitives, minting session solids in request order", async () => {
    const client = newSession();
    const box = await client.request("solid.createBox", {
      width: mm(2),
      depth: mm(3),
      height: mm(4),
    });
    const sphere = await client.request("solid.createSphere", {
      radius: mm(1),
    });
    const cylinder = await client.request("solid.createCylinder", {
      radius: mm(1),
      height: mm(5),
    });
    const cone = await client.request("solid.createCone", {
      bottomRadius: mm(2),
      topRadius: mm(0),
      height: mm(3),
    });

    expect(box.solid).toBe("wsol_000001");
    expect(sphere.solid).toBe("wsol_000002");
    expect(cylinder.solid).toBe("wsol_000003");
    expect(cone.solid).toBe("wsol_000004");
  });

  it("runs booleans and measurements over the minted solids", async () => {
    const client = newSession();
    const box = await client.request("solid.createBox", {
      width: mm(2),
      depth: mm(3),
      height: mm(4),
    });
    const sphere = await client.request("solid.createSphere", {
      radius: mm(1),
    });

    const boxVolume = await client.request("solid.volume", {
      solid: box.solid,
    });
    expect(boxVolume.volume).toBe(24); // analytic: w·d·h

    const union = await client.request("solid.union", {
      operands: [box.solid, sphere.solid],
    });
    const unionVolume = await client.request("solid.volume", {
      solid: union.solid,
    });
    // The union contains the whole box and adds at most the whole sphere.
    expect(unionVolume.volume).toBeGreaterThan(24 - 1e-6);
    expect(unionVolume.volume).toBeLessThan(24 + 4.18879 + 1e-6);

    const subtract = await client.request("solid.subtract", {
      target: box.solid,
      tools: [sphere.solid],
    });
    const subtractVolume = await client.request("solid.volume", {
      solid: subtract.solid,
    });
    expect(subtractVolume.volume).toBeGreaterThan(24 - 4.18879 - 1e-6);
    expect(subtractVolume.volume).toBeLessThanOrEqual(24 + 1e-6);

    const bounds = await client.request("solid.bounds", { solid: box.solid });
    expect(bounds.bounds).toEqual({ min: [0, 0, 0], max: [2, 3, 4] });

    const tessellation = await client.request("solid.tessellate", {
      solid: box.solid,
    });
    expect(tessellationTriangleCount(tessellation.tessellation)).toBe(
      FAKE_BOX_TRIANGLE_COUNT,
    );
  });

  it("runs the transform and reports translated bounds", async () => {
    const client = newSession();
    const box = await client.request("solid.createBox", {
      width: mm(2),
      depth: mm(3),
      height: mm(4),
    });
    const moved = await client.request("solid.transform", {
      solid: box.solid,
      translation: { x: mm(10), y: mm(0), z: mm(5) },
    });
    const bounds = await client.request("solid.bounds", { solid: moved.solid });
    expect(bounds.bounds).toEqual({ min: [10, 0, 5], max: [12, 3, 9] });
  });

  it("reports an empty intersection as zero volume and empty soup", async () => {
    const client = newSession();
    const boxA = await client.request("solid.createBox", {
      width: mm(2),
      depth: mm(3),
      height: mm(4),
    });
    const boxB = await client.request("solid.transform", {
      solid: boxA.solid,
      translation: { x: mm(10), y: mm(0), z: mm(0) },
    });
    const overlap = await client.request("solid.intersect", {
      operands: [boxA.solid, boxB.solid],
    });

    const volume = await client.request("solid.volume", {
      solid: overlap.solid,
    });
    expect(volume.volume).toBe(0);
    const soup = await client.request("solid.tessellate", {
      solid: overlap.solid,
    });
    expect(soup.tessellation.positions).toEqual([]);
    expect(soup.tessellation.indices).toEqual([]);
    const bounds = await failureOf(
      client.request("solid.bounds", { solid: overlap.solid }),
    );
    expect(bounds.error.code).toBe("worker/operation-failed");
    expect(bounds.error.data).toEqual({ kernelCode: "kernel/bounds-empty" });
  });

  it("serves concurrent requests with distinct ids and results", async () => {
    const client = newSession();
    const [box, sphere] = await Promise.all([
      client.request("solid.createBox", {
        width: mm(2),
        depth: mm(3),
        height: mm(4),
      }),
      client.request("solid.createSphere", { radius: mm(1) }),
    ]);
    expect(box.solid).toBe("wsol_000001");
    expect(sphere.solid).toBe("wsol_000002");

    const [boxVolume, sphereVolume] = await Promise.all([
      client.request("solid.volume", { solid: box.solid }),
      client.request("solid.volume", { solid: sphere.solid }),
    ]);
    expect(boxVolume.volume).toBe(24);
    expect(sphereVolume.volume).toBeCloseTo(4.18879, 5);
  });
});

describe("session solid-id lifecycle", () => {
  it("releases on dispose and answers use-after-dispose as solid-not-owned", async () => {
    const client = newSession();
    const box = await client.request("solid.createBox", {
      width: mm(2),
      depth: mm(3),
      height: mm(4),
    });

    const disposed = await client.request("solid.dispose", {
      solid: box.solid,
    });
    expect(disposed).toBeNull();

    const volume = await failureOf(
      client.request("solid.volume", { solid: box.solid }),
    );
    expect(volume.error.code).toBe("worker/operation-failed");
    expect(volume.error.data).toEqual({ kernelCode: "kernel/solid-not-owned" });

    const redispose = await failureOf(
      client.request("solid.dispose", { solid: box.solid }),
    );
    expect(redispose.error.data).toEqual({
      kernelCode: "kernel/solid-not-owned",
    });
  });

  it("answers a never-minted solid reference as solid-not-owned", async () => {
    const client = newSession();
    const unknown = createWorkerSolidId("wsol_099999");
    const failure = await failureOf(
      client.request("solid.union", { operands: [unknown, unknown] }),
    );
    expect(failure.error.code).toBe("worker/operation-failed");
    expect(failure.error.data).toEqual({
      kernelCode: "kernel/solid-not-owned",
    });
  });

  it("answers solid-not-owned for every operation kind that consumes a solid", async () => {
    const client = newSession();
    const disposed = await client.request("solid.createBox", {
      width: mm(2),
      depth: mm(3),
      height: mm(4),
    });
    const alive = await client.request("solid.createSphere", { radius: mm(1) });
    await client.request("solid.dispose", { solid: disposed.solid });

    const attempts: Array<Promise<WorkerRequestFailure>> = [
      failureOf(
        client.request("solid.transform", {
          solid: disposed.solid,
          translation: { x: mm(1), y: mm(1), z: mm(1) },
        }),
      ),
      failureOf(client.request("solid.bounds", { solid: disposed.solid })),
      failureOf(client.request("solid.tessellate", { solid: disposed.solid })),
      failureOf(
        client.request("solid.intersect", {
          operands: [disposed.solid, disposed.solid],
        }),
      ),
      failureOf(
        client.request("solid.subtract", {
          target: alive.solid,
          tools: [disposed.solid],
        }),
      ),
      failureOf(
        client.request("solid.subtract", {
          target: disposed.solid,
          tools: [alive.solid],
        }),
      ),
    ];
    for (const attempt of attempts) {
      const failure = await attempt;
      expect(failure.error.code).toBe("worker/operation-failed");
      expect(failure.error.data).toEqual({
        kernelCode: "kernel/solid-not-owned",
      });
    }
  });
});

describe("session failure propagation", () => {
  it("propagates a kernel semantic rejection with its stable code", async () => {
    const client = newSession();
    const failure = await failureOf(
      client.request("solid.createSphere", { radius: mm(-1) }),
    );
    expect(failure.error.code).toBe("worker/operation-failed");
    expect(failure.error.data).toEqual({ kernelCode: "kernel/invalid-length" });
  });

  it("propagates a malformed operand list rejection", async () => {
    const client = newSession();
    const box = await client.request("solid.createBox", {
      width: mm(2),
      depth: mm(3),
      height: mm(4),
    });
    const failure = await failureOf(
      client.request("solid.union", { operands: [box.solid] }),
    );
    expect(failure.error.data).toEqual({
      kernelCode: "kernel/invalid-operands",
    });
  });
});

describe("session cancellation over the full stack", () => {
  it("voids a request cancelled mid-flight, consuming no solid id", async () => {
    const client = newSession();
    const box = client.request("solid.createBox", {
      width: mm(2),
      depth: mm(3),
      height: mm(4),
    });
    client.cancel(createWorkerRequestId("req_000001"));
    const failure = await failureOf(box);
    expect(failure.error.code).toBe("worker/cancelled");

    // The suppressed computation minted nothing: the next delivered solid
    // takes the id the voided box would have taken.
    const sphere = await client.request("solid.createSphere", {
      radius: mm(1),
    });
    expect(sphere.solid).toBe("wsol_000001");
  });

  it("leaves a settled request's result standing when cancelled late", async () => {
    const client = newSession();
    const box = await client.request("solid.createBox", {
      width: mm(2),
      depth: mm(3),
      height: mm(4),
    });
    client.cancel(createWorkerRequestId("req_000001")); // already settled: no-op

    const volume = await client.request("solid.volume", { solid: box.solid });
    expect(volume.volume).toBe(24); // the solid was never voided
  });
});

describe("session determinism", () => {
  it("assigns identical ids and results for an identical request sequence", async () => {
    const runSequence = async (): Promise<unknown> => {
      const client = newSession();
      const box = await client.request("solid.createBox", {
        width: mm(2),
        depth: mm(3),
        height: mm(4),
      });
      const sphere = await client.request("solid.createSphere", {
        radius: mm(1),
      });
      const union = await client.request("solid.union", {
        operands: [box.solid, sphere.solid],
      });
      const volume = await client.request("solid.volume", {
        solid: union.solid,
      });
      const bounds = await client.request("solid.bounds", {
        solid: union.solid,
      });
      const soup = await client.request("solid.tessellate", {
        solid: union.solid,
      });
      await client.request("solid.dispose", { solid: sphere.solid });
      return { box, sphere, union, volume, bounds, soup };
    };

    expect(await runSequence()).toEqual(await runSequence());
  });
});
