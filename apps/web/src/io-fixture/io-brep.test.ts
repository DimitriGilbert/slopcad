/**
 * The BREP worker-flow helpers' dispose discipline (review Phase 9.A): the
 * `io-step` twin's tests over the `brep.*` vocabulary — a rejection at ANY
 * step of the import or export flow must still release every session solid
 * the flow minted, exactly once each. Each test hosts the real worker
 * server over the fake kernel on an in-memory transport (the wire
 * protocol's own session-solid ownership is part of what is exercised: a
 * double dispose is refused by the session before the kernel is called),
 * with a counting kernel wrapper recording every `dispose` per handle.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import {
  KERNEL_ERROR_CODES,
  WorkerRequestFailure,
  createFakeKernel,
  createInMemoryTransportPair,
  createWorkerClient,
  createWorkerServer,
  type GeometryKernel,
  type KernelSolid,
  type WorkerClient,
  type WorkerServer,
} from "@slopcad/cad-kernel";

import {
  exportPlateBrepOverWorker,
  importBrepBytesOverWorker,
} from "./io-brep";

const mm = (value: number) => length(value, "mm");

const IMPORT_BYTES = new Uint8Array([0x44, 0x42, 0x52, 0x45, 0x50]);
const EXPORT_BYTES = new Uint8Array([0x42, 0x52, 0x45, 0x50]);

/** What one hosted flow exposes to its assertions. */
interface BrepFlowHarness {
  readonly client: WorkerClient;
  /** Handles minted by the import extension, in file order. */
  readonly imported: readonly KernelSolid[];
  /** Total `dispose` calls that reached the kernel. */
  readonly disposeCalls: () => number;
  /** `dispose` calls per handle (handles are identity-keyed). */
  readonly disposeCounts: () => ReadonlyMap<KernelSolid, number>;
  /** Tears the channel down. */
  readonly close: () => void;
}

function createBrepFlowHarness(options: {
  /** How many solids the `brep.import` extension mints. */
  readonly importCount: number;
  /** Fails `tessellate` of the imported solid at this index, structurally. */
  readonly failTessellateOf?: number;
  /** Fails every `subtract`, structurally. */
  readonly failSubtract?: boolean;
}): BrepFlowHarness {
  const base = createFakeKernel();
  const imported: KernelSolid[] = [];
  const counts = new Map<KernelSolid, number>();
  let calls = 0;
  const kernel: GeometryKernel = {
    ...base,
    tessellate: (solid) => {
      if (
        options.failTessellateOf !== undefined &&
        imported.indexOf(solid) === options.failTessellateOf
      ) {
        return {
          ok: false,
          error: {
            code: KERNEL_ERROR_CODES.unsupportedOperation,
            message: "injected tessellate rejection",
            input: solid,
          },
        };
      }
      return base.tessellate(solid);
    },
    subtract: (target, tools) => {
      if (options.failSubtract) {
        return {
          ok: false,
          error: {
            code: KERNEL_ERROR_CODES.invalidOperands,
            message: "injected subtract rejection",
            input: { target, tools: tools.length },
          },
        };
      }
      return base.subtract(target, tools);
    },
    dispose: (solid) => {
      calls += 1;
      counts.set(solid, (counts.get(solid) ?? 0) + 1);
      base.dispose(solid);
    },
  };
  const pair = createInMemoryTransportPair();
  const server: WorkerServer = createWorkerServer({
    kernel,
    transport: pair.server,
    brepImport: (bytes) => {
      if (bytes.byteLength === 0) {
        return {
          ok: false,
          error: {
            code: "brep-import/empty",
            message: "the harness rejects empty input",
            input: bytes,
          },
        };
      }
      const solids: KernelSolid[] = [];
      for (let index = 0; index < options.importCount; index += 1) {
        const created = base.createBox({
          width: mm(2),
          depth: mm(3),
          height: mm(4),
        });
        if (!created.ok) {
          throw new Error("The harness box creation must succeed.");
        }
        solids.push(created.value);
      }
      imported.push(...solids);
      return { ok: true, value: solids };
    },
    brepExport: (solids) => {
      if (solids.length === 0) {
        return {
          ok: false,
          error: {
            code: "brep-export/empty",
            message: "the harness refuses to export nothing",
            input: solids.length,
          },
        };
      }
      return { ok: true, value: EXPORT_BYTES.slice() };
    },
  });
  const client = createWorkerClient({ transport: pair.client });
  return {
    client,
    imported,
    disposeCalls: () => calls,
    disposeCounts: () => counts,
    close: () => {
      client.close();
      server.close();
    },
  };
}

/** Every recorded dispose ran exactly once over exactly these handles. */
function expectEveryHandleDisposedExactlyOnce(
  harness: BrepFlowHarness,
  expected: readonly KernelSolid[],
): void {
  const counts = harness.disposeCounts();
  expect(counts.size).toBe(expected.length);
  for (const handle of expected) {
    expect(counts.get(handle)).toBe(1);
  }
  expect(harness.disposeCalls()).toBe(expected.length);
}

describe("importBrepBytesOverWorker", () => {
  it("disposes every imported solid exactly once on the happy path", async () => {
    const harness = createBrepFlowHarness({ importCount: 3 });
    try {
      const flow = await importBrepBytesOverWorker(
        harness.client,
        IMPORT_BYTES,
      );
      expect(flow.soups).toHaveLength(3);
      expect(flow.refs).toHaveLength(3);
      expectEveryHandleDisposedExactlyOnce(harness, harness.imported);
    } finally {
      harness.close();
    }
  });

  it("disposes solids k..n when solid k's tessellate rejects", async () => {
    const harness = createBrepFlowHarness({
      importCount: 3,
      failTessellateOf: 1,
    });
    try {
      await expect(
        importBrepBytesOverWorker(harness.client, IMPORT_BYTES),
      ).rejects.toBeInstanceOf(WorkerRequestFailure);
      // Solid 0 was released by the loop; solids 1 and 2 by the finally —
      // the whole import batch, each exactly once.
      expectEveryHandleDisposedExactlyOnce(harness, harness.imported);
    } finally {
      harness.close();
    }
  });
});

describe("exportPlateBrepOverWorker", () => {
  it("disposes every minted build solid exactly once on the happy path", async () => {
    const harness = createBrepFlowHarness({ importCount: 0 });
    try {
      const exported = await exportPlateBrepOverWorker(harness.client);
      expect(exported).toEqual(EXPORT_BYTES);
      // Box, cylinder, transform result, subtract result: four session
      // solids, each released exactly once.
      expect(harness.disposeCalls()).toBe(4);
      for (const count of harness.disposeCounts().values()) {
        expect(count).toBe(1);
      }
      expect(harness.disposeCounts().size).toBe(4);
    } finally {
      harness.close();
    }
  });

  it("disposes the box, cylinder, and transform solids when subtract rejects", async () => {
    const harness = createBrepFlowHarness({
      importCount: 0,
      failSubtract: true,
    });
    try {
      await expect(
        exportPlateBrepOverWorker(harness.client),
      ).rejects.toBeInstanceOf(WorkerRequestFailure);
      // The subtract never minted, so exactly the three prior mints are
      // released — each exactly once.
      expect(harness.disposeCalls()).toBe(3);
      for (const count of harness.disposeCounts().values()) {
        expect(count).toBe(1);
      }
      expect(harness.disposeCounts().size).toBe(3);
    } finally {
      harness.close();
    }
  });
});
