/**
 * React-level tests for the `useRenderGeometry` lifecycle: post-commit sync,
 * in-place updates across projection changes, exact-once `onSync` reporting,
 * unmount disposal, and StrictMode simulated-remount resurrection. These run
 * in jsdom with no WebGL and no R3F reconciler — rendering itself is
 * browser-scoped (Phase 11.3); what is proven here is the data flow React
 * drives.
 */

import { renderHook } from "@testing-library/react";
import type * as THREE from "three";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { RenderProjection } from "@slopcad/cad-core";
import type { RenderGeometrySnapshot } from "./geometry";

import { FOLDED_SHEET_SHARED, makeObject, makeProjection } from "./render-fixtures";
import { useRenderGeometry } from "./use-render-geometry";

const PLATE = makeObject("plate", FOLDED_SHEET_SHARED);
const BLOCK = makeObject("block", FOLDED_SHEET_SHARED);

const FIRST_PROJECTION: RenderProjection = makeProjection([PLATE, BLOCK]);
const MOVED_PLATE = makeObject("plate", {
  positions: [0, 0, 0, 2, 0, 0, 1, 1, 0, 1, 0, -1],
  indices: [0, 1, 2, 0, 1, 3],
});
const MOVED_PROJECTION: RenderProjection = makeProjection([MOVED_PLATE, BLOCK]);
const PLATE_ONLY_PROJECTION: RenderProjection = makeProjection([MOVED_PLATE]);

/** Attaches a dispose counter to a geometry and returns its reader. */
function trackDisposals(geometry: THREE.BufferGeometry): () => number {
  let count = 0;
  geometry.addEventListener("dispose", () => {
    count += 1;
  });
  return () => count;
}

describe("useRenderGeometry", () => {
  it("builds geometries from the first projection post-commit", () => {
    const { result } = renderHook(() => useRenderGeometry(FIRST_PROJECTION));
    expect(result.current.size).toBe(2);
    const plate = result.current.get(PLATE.id);
    if (plate === undefined) {
      throw new Error("Expected geometry for the plate object.");
    }
    expect(plate.getAttribute("position").count).toBe(4);
  });

  it("updates in place across projection changes and disposes vanished ids", () => {
    const { result, rerender, unmount } = renderHook(
      ({ projection }) => useRenderGeometry(projection),
      { initialProps: { projection: FIRST_PROJECTION } },
    );
    const plateBefore = result.current.get(PLATE.id);
    const blockBefore = result.current.get(BLOCK.id);
    if (plateBefore === undefined || blockBefore === undefined) {
      throw new Error("Expected geometries for both objects.");
    }
    let blockDisposals = 0;
    blockBefore.addEventListener("dispose", () => {
      blockDisposals += 1;
    });
    rerender({ projection: MOVED_PROJECTION });
    expect(result.current.get(PLATE.id)).toBe(plateBefore);
    expect(plateBefore.getAttribute("position").getX(1)).toBe(Math.fround(2));
    expect(blockDisposals).toBe(0);
    rerender({ projection: PLATE_ONLY_PROJECTION });
    expect(result.current.has(BLOCK.id)).toBe(false);
    expect(blockDisposals).toBe(1);
    unmount();
  });

  it("reports onSync exactly once per changed snapshot and never for equal ones", () => {
    const onSync = vi.fn<(snapshot: RenderGeometrySnapshot) => void>();
    const { rerender } = renderHook(
      ({ projection }) => useRenderGeometry(projection, onSync),
      { initialProps: { projection: FIRST_PROJECTION } },
    );
    expect(onSync).toHaveBeenCalledTimes(1);
    rerender({ projection: makeProjection([PLATE, BLOCK]) });
    expect(onSync).toHaveBeenCalledTimes(1);
    rerender({ projection: MOVED_PROJECTION });
    expect(onSync).toHaveBeenCalledTimes(2);
    const lastReport = onSync.mock.lastCall?.[0];
    expect(lastReport?.size).toBe(2);
  });

  it("resurrects geometries under StrictMode and disposes each exactly once on unmount", () => {
    const readers = new Map<THREE.BufferGeometry, () => number>();
    const onSync = (snapshot: RenderGeometrySnapshot): void => {
      for (const geometry of snapshot.values()) {
        if (!readers.has(geometry)) {
          readers.set(geometry, trackDisposals(geometry));
        }
      }
    };
    const { result, unmount } = renderHook(
      ({ projection }) => useRenderGeometry(projection, onSync),
      {
        initialProps: { projection: FIRST_PROJECTION },
        wrapper: StrictMode,
      },
    );
    expect(result.current.size).toBe(2);
    expect(readers.size).toBeGreaterThanOrEqual(2);
    unmount();
    for (const read of readers.values()) {
      expect(read()).toBe(1);
    }
  });

  it("disposes every geometry on unmount", () => {
    const { result, unmount } = renderHook(() =>
      useRenderGeometry(FIRST_PROJECTION),
    );
    const readers = [...result.current.values()].map((geometry) => ({
      read: trackDisposals(geometry),
    }));
    unmount();
    for (const { read } of readers) {
      expect(read()).toBe(1);
    }
  });
});
