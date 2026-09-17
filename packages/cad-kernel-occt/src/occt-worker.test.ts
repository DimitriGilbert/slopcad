/**
 * Real-worker integration tests (Phase 21.2): the full operation matrix —
 * primitives, booleans, the transform including its ROTATION extension,
 * measurements, tessellation, the disposal lifecycle — executed by the REAL
 * OpenCascade kernel inside a REAL `node:worker_threads` thread, reached
 * only through the worker protocol over the node transport adapter.
 *
 * The twin of the Manifold worker tests, with OCCT-specific judgements:
 *
 * - Volumes ride the exact band (1e-9 relative), not Manifold's curved
 *   tolerance — OCCT's BREP integration is exact (probed in the pre-spike
 *   and pinned by the 21.1 adapter tests), so a wire round trip that
 *   blunted the numbers would be a real regression, not noise.
 * - The rotation extension is exercised over the wire end-to-end: a
 *   rotation-only transform, a rotation+translation transform (the
 *   contract's application order), and a non-unit axis — plus its
 *   structured rejection over the wire (`kernel/invalid-rotation`).
 * - The negative-dimension guard is load-bearing here: OCCT itself
 *   silently builds mirrored geometry for negative input (the pre-spike's
 *   core warning), so the kernel-side validation firing through the wire is
 *   the only thing standing between a caller and a wrong solid.
 * - Determinism across fresh workers covers the rotation too: identical
 *   request sequences mint identical solid ids and byte-identical soup.
 * - The Phase 21.3 `step.import` extension executes over the wire: the
 *   committed fixture imports into provenance-marked solids whose ids
 *   address exact volume/bounds measurements, malformed bytes fail with the
 *   kernel-side `step-import/*` code in the error data, and disposal
 *   settles ownership like any other session solid.
 * - The Phase 21.4 `step.export` twin executes over the wire: the session's
 *   wire-built solids export to deterministic STEP bytes (the neutralized
 *   epoch stamp and AP214 schema ride the file), the bytes re-import through
 *   the same channel with exact semantics, structured `step-export/*`
 *   rejections surface in the error data, and fresh worker runtimes export
 *   byte-identical files — the cross-runtime determinism pin.
 * - The Phase 21.5 `brep.import`/`brep.export` pair executes over the wire
 *   with the same discipline: the committed fixture imports into a
 *   provenance-marked exact solid, the wire-built plate exports bytes that
 *   equal the fixture BYTE-FOR-BYTE (the BREP writer carries no
 *   timestamp/counter, so cross-process byte-identity needs no neutralizer),
 *   and the structured `brep-*` rejections surface in the error data.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  KERNEL_ERROR_CODES,
  WORKER_PROTOCOL_ERROR_CODES,
} from "@slopcad/cad-kernel";
import type { KernelBounds } from "@slopcad/cad-kernel";
import {
  EXACT_BOUNDS_TOLERANCE,
  EXACT_VOLUME_TOLERANCE,
} from "@slopcad/cad-kernel/contract-suite";
import type { WorkerClient, WorkerSolidId } from "@slopcad/cad-kernel";

import { createNodeOcctWorkerChannel } from "./node-occt-worker";

/** The committed Phase 21.3 fixture: the plate-with-hole as a real STEP file. */
const FIXTURE_BYTES = new Uint8Array(
  readFileSync(new URL("../fixtures/plate-with-hole.step", import.meta.url)),
);

/** The committed Phase 21.5 fixture: the same plate as a real OCCT BREP file. */
const BREP_FIXTURE_BYTES = new Uint8Array(
  readFileSync(new URL("../fixtures/plate-with-hole.brep", import.meta.url)),
);

const mm = (value: number) => length(value, "mm");
const deg = (value: number) => angle(value, "deg");

let client: WorkerClient;
let channelToClose: ReturnType<typeof createNodeOcctWorkerChannel> | undefined;

// Channel creation is synchronous: requests posted before the worker's
// WASM runtime finishes booting (OCCT: ~200 ms of init, probed) buffer on
// the port and are answered once the server subscribes, so no readiness
// handshake is needed.
beforeAll(() => {
  channelToClose = createNodeOcctWorkerChannel();
  client = channelToClose.client;
});

afterAll(async () => {
  await channelToClose?.close();
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

function expectExactVolume(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / expected).toBeLessThan(
    EXACT_VOLUME_TOLERANCE,
  );
}

/**
 * Rotated bounds carry last-ulp rounding through the rigid transform (the
 * same behavior the 21.1 adapter tests pin with `EXACT_BOUNDS_TOLERANCE`),
 * so wire bounds compare per-component inside the exact band — never byte
 * equality.
 */
function expectBoundsClose(
  actual: KernelBounds,
  expected: {
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  },
): void {
  for (const corner of ["min", "max"] as const) {
    const a = actual[corner];
    const e = expected[corner];
    for (let axis = 0; axis < 3; axis += 1) {
      const got = a[axis];
      const want = e[axis];
      if (got === undefined || want === undefined) {
        throw new Error("Bounds corners are triples by contract.");
      }
      expect(Math.abs(got - want)).toBeLessThan(EXACT_BOUNDS_TOLERANCE);
    }
  }
}

describe("the occt worker over a real node worker channel", () => {
  it("executes the full operation matrix with kernel-neutral, exact results", async () => {
    // Primitives: every one exact to OCCT's analytic/BREP integration.
    const sphere = await client.request("solid.createSphere", {
      radius: mm(2),
    });
    const sphereVolume = await client.request("solid.volume", {
      solid: sphere.solid,
    });
    expectExactVolume(sphereVolume.volume, (4 / 3) * Math.PI * 2 ** 3);

    const cylinder = await client.request("solid.createCylinder", {
      radius: mm(2),
      height: mm(5),
    });
    const cylinderVolume = await client.request("solid.volume", {
      solid: cylinder.solid,
    });
    expectExactVolume(cylinderVolume.volume, Math.PI * 2 ** 2 * 5);

    // The cone is OCCT's composed primitive (profile revolve, Phase
    // 21.1); over the wire it is judged like any primitive.
    const cone = await client.request("solid.createCone", {
      bottomRadius: mm(3),
      topRadius: mm(1),
      height: mm(9),
    });
    const coneVolume = await client.request("solid.volume", {
      solid: cone.solid,
    });
    expectExactVolume(
      coneVolume.volume,
      (Math.PI * 9 * (3 ** 2 + 3 * 1 + 1 ** 2)) / 3,
    );

    // Booleans over the wire: union of two disjoint blocks, a bore
    // drilled through (translated cylinder), a clip intersect.
    const left = await createBox(10, 10, 10);
    const rightAtOrigin = await createBox(10, 10, 10);
    const right = await client.request("solid.transform", {
      solid: rightAtOrigin,
      translation: { x: mm(30), y: mm(0), z: mm(0) },
    });
    const union = await client.request("solid.union", {
      operands: [left, right.solid],
    });
    const unionVolume = await client.request("solid.volume", {
      solid: union.solid,
    });
    expectExactVolume(unionVolume.volume, 2 * 10 ** 3);

    const boreAtOrigin = await client.request("solid.createCylinder", {
      radius: mm(3),
      height: mm(10),
    });
    const bore = await client.request("solid.transform", {
      solid: boreAtOrigin.solid,
      translation: { x: mm(5), y: mm(5), z: mm(0) },
    });
    const cut = await client.request("solid.subtract", {
      target: union.solid,
      tools: [bore.solid],
    });
    const cutVolume = await client.request("solid.volume", {
      solid: cut.solid,
    });
    expectExactVolume(cutVolume.volume, 2 * 10 ** 3 - Math.PI * 3 ** 2 * 10);

    const clip = await createBox(20, 10, 10);
    const trimmed = await client.request("solid.intersect", {
      operands: [cut.solid, clip],
    });
    const trimmedVolume = await client.request("solid.volume", {
      solid: trimmed.solid,
    });
    expectExactVolume(trimmedVolume.volume, 10 ** 3 - Math.PI * 3 ** 2 * 10);

    // Bounds cross the wire exact (tight, planar faces).
    const trimmedBounds = await client.request("solid.bounds", {
      solid: trimmed.solid,
    });
    expect(trimmedBounds.bounds).toEqual({
      min: [0, 0, 0],
      max: [10, 10, 10],
    });

    // Tessellation crosses as plain arrays with kernel-computed unit
    // normals paired index-for-index with the positions.
    const { tessellation } = await client.request("solid.tessellate", {
      solid: trimmed.solid,
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

    // Disposal closes the lifecycle over the wire.
    const disposed = await client.request("solid.dispose", {
      solid: sphere.solid,
    });
    expect(disposed).toBeNull();
  }, 60_000);

  it("rotates through the wire extension: exact rotated bounds, application order, non-unit axes", async () => {
    const box = await createBox(20, 10, 5);

    // Rotation only, 90° about z in degrees (any angle unit parses): the
    // box's analytic rotated footprint is exact.
    const rotated = await client.request("solid.transform", {
      solid: box,
      translation: { x: mm(0), y: mm(0), z: mm(0) },
      rotation: { axis: [0, 0, 1], angle: deg(90) },
    });
    const rotatedBounds = await client.request("solid.bounds", {
      solid: rotated.solid,
    });
    expectBoundsClose(rotatedBounds.bounds, {
      min: [-10, 0, 0],
      max: [0, 20, 5],
    });
    const rotatedVolume = await client.request("solid.volume", {
      solid: rotated.solid,
    });
    expectExactVolume(rotatedVolume.volume, 20 * 10 * 5);

    // Rotation FIRST, translation SECOND (the contract's pinned order):
    // the world-origin rotation of the same box then a +40 x translation
    // lands the footprint at x ∈ [30, 40].
    const placed = await client.request("solid.transform", {
      solid: box,
      translation: { x: mm(40), y: mm(0), z: mm(0) },
      rotation: { axis: [0, 0, 1], angle: deg(90) },
    });
    const placedBounds = await client.request("solid.bounds", {
      solid: placed.solid,
    });
    expectBoundsClose(placedBounds.bounds, {
      min: [30, 0, 0],
      max: [40, 20, 5],
    });

    // A non-unit axis parses and the kernel normalizes it: same result
    // as the unit axis (structure only on the wire, semantics inside).
    const scaledAxis = await client.request("solid.transform", {
      solid: box,
      translation: { x: mm(0), y: mm(0), z: mm(0) },
      rotation: { axis: [0, 0, 7], angle: deg(90) },
    });
    const scaledAxisBounds = await client.request("solid.bounds", {
      solid: scaledAxis.solid,
    });
    expect(scaledAxisBounds.bounds).toEqual(rotatedBounds.bounds);
  }, 60_000);

  it("keeps a boolean result usable after rotation: drill, rotate, measure, tessellate", async () => {
    // The matrix the phase gate cares about, composed: boolean →
    // rotation → measure → tessellate.
    const plate = await createBox(30, 20, 10);
    const boreAtOrigin = await client.request("solid.createCylinder", {
      radius: mm(4),
      height: mm(10),
    });
    const bore = await client.request("solid.transform", {
      solid: boreAtOrigin.solid,
      translation: { x: mm(15), y: mm(10), z: mm(0) },
    });
    const drilled = await client.request("solid.subtract", {
      target: plate,
      tools: [bore.solid],
    });
    const rotated = await client.request("solid.transform", {
      solid: drilled.solid,
      translation: { x: mm(40), y: mm(0), z: mm(0) },
      rotation: { axis: [0, 0, 1], angle: deg(90) },
    });
    const volume = await client.request("solid.volume", {
      solid: rotated.solid,
    });
    const analytic = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;
    expectExactVolume(volume.volume, analytic);
    const bounds = await client.request("solid.bounds", {
      solid: rotated.solid,
    });
    expectBoundsClose(bounds.bounds, {
      min: [20, 0, 0],
      max: [40, 30, 10],
    });
    const { tessellation } = await client.request("solid.tessellate", {
      solid: rotated.solid,
    });
    expect(tessellation.indices.length / 3).toBeGreaterThan(0);
    const plain = await client.request("solid.dispose", {
      solid: rotated.solid,
    });
    expect(plain).toBeNull();
  }, 60_000);

  it("runs the disposal lifecycle: dispose resolves null, and use-after-dispose fails with the kernel's solid-not-owned code", async () => {
    const box = await createBox(1, 1, 1);
    const disposed = await client.request("solid.dispose", { solid: box });
    expect(disposed).toBeNull();

    await expect(
      client.request("solid.volume", { solid: box }),
    ).rejects.toMatchObject({
      name: "WorkerRequestFailure",
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: KERNEL_ERROR_CODES.solidNotOwned },
      },
    });
    // The channel stays healthy after a structured failure.
    const sphere = await client.request("solid.createSphere", {
      radius: mm(1),
    });
    expect(typeof sphere.solid).toBe("string");
  }, 60_000);

  it("carries the load-bearing validation guards over the wire as structured operation failures", async () => {
    // Negative dimensions: OCCT itself would silently build mirrored
    // geometry (the pre-spike's core warning) — the kernel's guard is
    // the only defence, and it must fire through the channel.
    await expect(
      client.request("solid.createBox", {
        width: mm(-10),
        depth: mm(10),
        height: mm(10),
      }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: KERNEL_ERROR_CODES.invalidLength },
      },
    });
    await expect(
      client.request("solid.createSphere", { radius: mm(0) }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: KERNEL_ERROR_CODES.invalidLength },
      },
    });
    await expect(
      client.request("solid.createCone", {
        bottomRadius: mm(2),
        topRadius: mm(-1),
        height: mm(4),
      }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: KERNEL_ERROR_CODES.invalidLength },
      },
    });

    // Degenerate rotation over the wire: a zero axis is the kernel's
    // structured invalid-rotation, not a silent mis-placement.
    const box = await createBox(2, 2, 2);
    await expect(
      client.request("solid.transform", {
        solid: box,
        translation: { x: mm(0), y: mm(0), z: mm(0) },
        rotation: { axis: [0, 0, 0], angle: deg(90) },
      }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: KERNEL_ERROR_CODES.invalidRotation },
      },
    });

    // Operand-count rules ride the same shape.
    await expect(
      client.request("solid.union", { operands: [box] }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: KERNEL_ERROR_CODES.invalidOperands },
      },
    });
  }, 60_000);

  it("produces identical results for identical sequences (rotation included) over fresh workers", async () => {
    const runScene = async (): Promise<{
      readonly solids: readonly WorkerSolidId[];
      readonly volume: number;
      readonly bounds: unknown;
      readonly positions: readonly number[];
      readonly indices: readonly number[];
      readonly normals: readonly number[];
    }> => {
      const fresh = createNodeOcctWorkerChannel();
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
        const drilled = await fresh.client.request("solid.subtract", {
          target: plate.solid,
          tools: [bore.solid],
        });
        solids.push(drilled.solid);
        const rotated = await fresh.client.request("solid.transform", {
          solid: drilled.solid,
          translation: { x: mm(40), y: mm(0), z: mm(0) },
          rotation: { axis: [0, 0, 1], angle: deg(90) },
        });
        solids.push(rotated.solid);
        const volume = await fresh.client.request("solid.volume", {
          solid: rotated.solid,
        });
        const bounds = await fresh.client.request("solid.bounds", {
          solid: rotated.solid,
        });
        const tessellated = await fresh.client.request("solid.tessellate", {
          solid: rotated.solid,
        });
        const tessellation = tessellated.tessellation;
        if (tessellation.normals === undefined) {
          throw new Error("The rotated plate must carry kernel normals.");
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
    // The single-thread build is input-deterministic: identical scenes
    // (booleans and the rotation included) produce bit-identical numbers
    // and meshes.
    expect(second.volume).toBe(first.volume);
    const analyticPlateVolume = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;
    expect(
      Math.abs(second.volume - analyticPlateVolume) / analyticPlateVolume,
    ).toBeLessThan(EXACT_VOLUME_TOLERANCE);
    expect(second.bounds).toEqual(first.bounds);
    expect(second.positions).toEqual(first.positions);
    expect(second.indices).toEqual(first.indices);
    expect(second.normals).toEqual(first.normals);
  }, 120_000);

  it("imports the STEP fixture over the wire into provenance-marked, exact solids", async () => {
    // The Phase 21.3 extension executes on the hosted kernel: bytes in,
    // one minted session id per imported solid, each ref carrying the
    // imported-step provenance literal.
    const imported = await client.request("step.import", {
      data: FIXTURE_BYTES,
    });
    expect(imported.solids).toHaveLength(1);
    const ref = imported.solids[0];
    expect(ref?.origin).toBe("imported-step");
    const minted = ref?.solid;
    if (minted === undefined) throw new Error("The import minted no solid.");

    // The minted id addresses an ordinary session solid: exact volume and
    // exact tight bounds of the plate-with-hole, in canonical mm.
    const volume = await client.request("solid.volume", { solid: minted });
    const analytic = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;
    expectExactVolume(volume.volume, analytic);
    const bounds = await client.request("solid.bounds", { solid: minted });
    expectBoundsClose(bounds.bounds, {
      min: [0, 0, 0],
      max: [30, 20, 10],
    });

    // Malformed bytes fail structurally over the wire, with the
    // kernel-side step-import code in the error data.
    const rejected = client.request("step.import", { data: new Uint8Array(0) });
    await expect(rejected).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: "step-import/empty" },
      },
    });

    // Disposal settles the imported solid's ownership like any other.
    await client.request("solid.dispose", { solid: minted });
    const after = client.request("solid.volume", { solid: minted });
    await expect(after).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: KERNEL_ERROR_CODES.solidNotOwned },
      },
    });
  }, 120_000);

  it("exports the wire-built plate as deterministic STEP bytes that re-import exactly (Phase 21.4)", async () => {
    // The export twin over the wire: the session's solids in, one STEP
    // file's bytes out — then the channel's own importer reads them back.
    const plate = await client.request("solid.createBox", {
      width: mm(30),
      depth: mm(20),
      height: mm(10),
    });
    const boreAtOrigin = await client.request("solid.createCylinder", {
      radius: mm(4),
      height: mm(10),
    });
    const bore = await client.request("solid.transform", {
      solid: boreAtOrigin.solid,
      translation: { x: mm(15), y: mm(10), z: mm(0) },
    });
    const drilled = await client.request("solid.subtract", {
      target: plate.solid,
      tools: [bore.solid],
    });

    const exported = await client.request("step.export", {
      solids: [drilled.solid],
    });
    expect(exported.data.byteLength).toBeGreaterThan(0);
    // The neutralized header rides the bytes: the fixed epoch stamp is the
    // ONLY ISO-8601 stamp anywhere (a live wall clock would betray itself
    // as a second, current-dated stamp; the worker has exported nothing
    // before this request, so a leaked product counter would read " 2"+).
    const text = new TextDecoder().decode(exported.data);
    const stamps = text.match(/'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/g) ?? [];
    expect(stamps).toEqual(["'1970-01-01T00:00:00'"]);
    expect(text).toContain(
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'))",
    );

    // The plan's criterion through the channel: the exported bytes
    // re-import and measure the plate's exact semantics.
    const reimported = await client.request("step.import", {
      data: exported.data,
    });
    expect(reimported.solids).toHaveLength(1);
    const roundTripSolid = reimported.solids[0]?.solid;
    if (roundTripSolid === undefined) {
      throw new Error("The re-import minted no solid.");
    }
    const roundTrip = await client.request("solid.volume", {
      solid: roundTripSolid,
    });
    const analytic = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;
    expectExactVolume(roundTrip.volume, analytic);

    // The structured rejections over the wire: an empty solid list and a
    // unit the binding refuses both surface the kernel-side step-export
    // codes in the error data.
    await expect(
      client.request("step.export", { solids: [] }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: "step-export/empty" },
      },
    });
    await expect(
      client.request("step.export", {
        solids: [drilled.solid],
        unit: "FURLONGS",
      }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: "step-export/invalid-unit" },
      },
    });

    // Disposal settles the source solid; a later export of it is the
    // session's solid-not-owned, exactly like any other operation.
    for (const id of [drilled.solid, plate.solid]) {
      await client.request("solid.dispose", { solid: id });
    }
    await expect(
      client.request("step.export", { solids: [drilled.solid] }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: KERNEL_ERROR_CODES.solidNotOwned },
      },
    });
  }, 120_000);

  it("exports byte-identical STEP across fresh worker runtimes (the determinism pin)", async () => {
    // Each node worker channel boots its own WASM runtime with its own
    // process-global writer state — the strongest determinism evidence the
    // test environment can produce: same scene, fresh runtimes, identical
    // bytes.
    const exportOverFreshChannel = async (): Promise<Uint8Array> => {
      const fresh = createNodeOcctWorkerChannel();
      try {
        const box = await fresh.client.request("solid.createBox", {
          width: mm(30),
          depth: mm(20),
          height: mm(10),
        });
        const boreAtOrigin = await fresh.client.request(
          "solid.createCylinder",
          { radius: mm(4), height: mm(10) },
        );
        const bore = await fresh.client.request("solid.transform", {
          solid: boreAtOrigin.solid,
          translation: { x: mm(15), y: mm(10), z: mm(0) },
        });
        const drilled = await fresh.client.request("solid.subtract", {
          target: box.solid,
          tools: [bore.solid],
        });
        // Offset the fresh runtime's product counter with an unrelated
        // export first — the neutralizer must still renumber from 1.
        const sphere = await fresh.client.request("solid.createSphere", {
          radius: mm(2),
        });
        await fresh.client.request("step.export", { solids: [sphere.solid] });
        const exported = await fresh.client.request("step.export", {
          solids: [drilled.solid],
        });
        return exported.data;
      } finally {
        await fresh.close();
      }
    };
    const first = await exportOverFreshChannel();
    const second = await exportOverFreshChannel();
    expect([...second]).toEqual([...first]);
    expect(first.byteLength).toBeGreaterThan(0);
  }, 240_000);

  it("round-trips BREP over the wire: fixture imports, exports equal it byte-for-byte, re-import measures exact (Phase 21.5)", async () => {
    // The committed fixture (written by a DIFFERENT process of the same
    // binding) imports through the wire into a provenance-marked solid.
    const imported = await client.request("brep.import", {
      data: BREP_FIXTURE_BYTES,
    });
    expect(imported.solids).toHaveLength(1);
    const ref = imported.solids[0];
    expect(ref?.origin).toBe("imported-brep");
    const minted = ref?.solid;
    if (minted === undefined) throw new Error("The import minted no solid.");
    const volume = await client.request("solid.volume", { solid: minted });
    const analytic = 30 * 20 * 10 - Math.PI * 4 ** 2 * 10;
    expectExactVolume(volume.volume, analytic);
    await client.request("solid.dispose", { solid: minted });

    // The wire-built plate exports to bytes that equal the fixture
    // BYTE-FOR-BYTE — the BREP writer needs no neutralizer, so this holds
    // across processes and fresh worker runtimes alike.
    const plate = await client.request("solid.createBox", {
      width: mm(30),
      depth: mm(20),
      height: mm(10),
    });
    const boreAtOrigin = await client.request("solid.createCylinder", {
      radius: mm(4),
      height: mm(10),
    });
    const bore = await client.request("solid.transform", {
      solid: boreAtOrigin.solid,
      translation: { x: mm(15), y: mm(10), z: mm(0) },
    });
    const drilled = await client.request("solid.subtract", {
      target: plate.solid,
      tools: [bore.solid],
    });
    const exported = await client.request("brep.export", {
      solids: [drilled.solid],
    });
    expect(exported.data.byteLength).toBeGreaterThan(0);
    expect([...exported.data]).toEqual([...BREP_FIXTURE_BYTES]);

    // The plan's criterion through the channel: the exported bytes
    // re-import with exact semantics and the brep provenance literal.
    const reimported = await client.request("brep.import", {
      data: exported.data,
    });
    expect(reimported.solids).toHaveLength(1);
    expect(reimported.solids[0]?.origin).toBe("imported-brep");
    const roundTripSolid = reimported.solids[0]?.solid;
    if (roundTripSolid === undefined) {
      throw new Error("The re-import minted no solid.");
    }
    const roundTrip = await client.request("solid.volume", {
      solid: roundTripSolid,
    });
    expectExactVolume(roundTrip.volume, analytic);

    // The structured rejections over the wire: malformed bytes carry the
    // kernel-side brep-import code, the empty solid list the brep-export
    // one — both in the error data, like every step.* twin.
    await expect(
      client.request("brep.import", { data: new Uint8Array(0) }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: "brep-import/empty" },
      },
    });
    await expect(
      client.request("brep.export", { solids: [] }),
    ).rejects.toMatchObject({
      error: {
        code: WORKER_PROTOCOL_ERROR_CODES.operationFailed,
        data: { kernelCode: "brep-export/empty" },
      },
    });

    for (const id of [roundTripSolid, drilled.solid, plate.solid] as const) {
      await client.request("solid.dispose", { solid: id });
    }
  }, 120_000);
});
