/**
 * Component tests for `CadModel`: one keyed mesh per render object with the
 * documented default material, parameter overrides, and update/dispose
 * semantics driven through real React commits. jsdom has no WebGL and the
 * R3F reconciler is not mounted here — the meshes surface as unknown host
 * elements and the geometry/material wiring is asserted through the
 * `onSync` snapshots and the material's host attributes. Full Canvas
 * rendering is browser evidence for Phase 11.3.
 */

import { cleanup, render } from "@testing-library/react";
import type * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { createBodyId } from "@slopcad/cad-core";
import type { RenderObjectId, RenderProjection } from "@slopcad/cad-core";
import type { RenderGeometrySnapshot } from "./geometry";

import { CadModel } from "./cad-model";
import { FOLDED_SHEET_SHARED, makeObject, makeProjection } from "./render-fixtures";

const PLATE = makeObject("plate", FOLDED_SHEET_SHARED);
const BLOCK = makeObject("block", FOLDED_SHEET_SHARED);
const BOTH_PROJECTION = makeProjection([PLATE, BLOCK]);

const MOVED_PLATE = makeObject("plate", {
  positions: [0, 0, 0, 3, 0, 0, 1, 1, 0, 1, 0, -1],
  indices: [0, 1, 2, 0, 1, 3],
});
const MOVED_PROJECTION = makeProjection([MOVED_PLATE, BLOCK]);
const PLATE_ONLY_PROJECTION = makeProjection([MOVED_PLATE]);

/** Renders CadModel and captures every onSync snapshot by id. */
function renderModel(projection: RenderProjection): {
  container: HTMLElement;
  snapshots: RenderGeometrySnapshot[];
  rerender: (next: RenderProjection) => void;
  unmount: () => void;
} {
  const snapshots: RenderGeometrySnapshot[] = [];
  const view = render(
    <CadModel projection={projection} onSync={(snapshot) => snapshots.push(snapshot)} />,
  );
  return {
    container: view.container,
    snapshots,
    rerender: (next) =>
      view.rerender(
        <CadModel projection={next} onSync={(snapshot) => snapshots.push(snapshot)} />,
      ),
    unmount: view.unmount,
  };
}

function geometryOf(snapshot: RenderGeometrySnapshot, id: RenderObjectId): THREE.BufferGeometry {
  const geometry = snapshot.get(id);
  if (geometry === undefined) {
    throw new Error(`Expected geometry for ${id}.`);
  }
  return geometry;
}

afterEach(cleanup);

describe("CadModel", () => {
  it("renders one mesh per render object with the documented default material", () => {
    const { container } = renderModel(BOTH_PROJECTION);
    const meshes = container.querySelectorAll("mesh");
    expect(meshes.length).toBe(2);
    for (const mesh of meshes) {
      const material = mesh.querySelector("meshstandardmaterial");
      expect(material?.getAttribute("color")).toBe("#8aadf4");
      expect(material?.getAttribute("metalness")).toBe("0.15");
      expect(material?.getAttribute("roughness")).toBe("0.55");
    }
  });

  it("applies material overrides over the defaults", () => {
    const view = render(
      <CadModel projection={BOTH_PROJECTION} material={{ color: "#ff5500" }} />,
    );
    const material = view.container.querySelector("meshstandardmaterial");
    expect(material?.getAttribute("color")).toBe("#ff5500");
    expect(material?.getAttribute("metalness")).toBe("0.15");
    expect(material?.getAttribute("roughness")).toBe("0.55");
  });

  it("replaces by stable id across projection updates and disposes removed geometry", () => {
    const { container, snapshots, rerender, unmount } = renderModel(BOTH_PROJECTION);
    expect(snapshots.length).toBe(1);
    const first = snapshots[0];
    if (first === undefined) {
      throw new Error("Expected the first snapshot.");
    }
    const plate = geometryOf(first, PLATE.id);
    let blockDisposals = 0;
    geometryOf(first, BLOCK.id).addEventListener("dispose", () => {
      blockDisposals += 1;
    });
    rerender(MOVED_PROJECTION);
    expect(snapshots.length).toBe(2);
    const second = snapshots[1];
    if (second === undefined) {
      throw new Error("Expected the second snapshot.");
    }
    expect(container.querySelectorAll("mesh").length).toBe(2);
    expect(geometryOf(second, PLATE.id)).toBe(plate);
    expect(plate.getAttribute("position").getX(1)).toBe(Math.fround(3));
    expect(blockDisposals).toBe(0);
    rerender(PLATE_ONLY_PROJECTION);
    expect(snapshots.length).toBe(3);
    expect(container.querySelectorAll("mesh").length).toBe(1);
    expect(blockDisposals).toBe(1);
    unmount();
    expect(blockDisposals).toBe(1);
  });

  it("renders nothing for an empty projection", () => {
    const { container } = renderModel(makeProjection([]));
    expect(container.querySelectorAll("mesh").length).toBe(0);
  });

  it("disposes every geometry on unmount", () => {
    const { snapshots, unmount } = renderModel(BOTH_PROJECTION);
    const first = snapshots[0];
    if (first === undefined) {
      throw new Error("Expected the first snapshot.");
    }
    const readers = [...first.values()].map((geometry) => {
      let count = 0;
      geometry.addEventListener("dispose", () => {
        count += 1;
      });
      return () => count;
    });
    unmount();
    for (const read of readers) {
      expect(read()).toBe(1);
    }
  });
});

describe("CadModel selection highlight", () => {
  const FACE_REF = {
    kind: "face",
    bodyId: createBodyId("body_plate"),
    regeneration: 5,
    faceIndex: 0,
  } as const;

  it("renders a second-pass highlight mesh for a current face reference", () => {
    const view = render(
      <CadModel
        projection={BOTH_PROJECTION}
        regeneration={5}
        selection={[FACE_REF]}
      />,
    );
    // One base mesh per object plus one highlight mesh for the plate.
    const meshes = view.container.querySelectorAll("mesh");
    expect(meshes.length).toBe(3);
    const highlight = view.container.querySelector('mesh[renderorder="1"]');
    expect(highlight).not.toBeNull();
    const material = highlight?.querySelector("meshbasicmaterial");
    expect(material?.getAttribute("color")).toBe("#f59e0b");
    expect(material?.getAttribute("polygonoffsetfactor")).toBe("-2");
    expect(material?.getAttribute("polygonoffsetunits")).toBe("-2");
    // React drops boolean-valued props on unknown host elements (this jsdom
    // rendering never mounts the R3F reconciler, which applies them as
    // object properties — the drawn pixels are the browser evidence).
  });

  it("never highlights a stale synthetic reference", () => {
    const view = render(
      <CadModel
        projection={BOTH_PROJECTION}
        regeneration={6}
        selection={[FACE_REF]}
      />,
    );
    // Two base meshes, zero highlight overlays.
    expect(view.container.querySelectorAll("mesh").length).toBe(2);
    expect(view.container.querySelector("meshbasicmaterial")).toBeNull();
  });

  it("applies the documented body-selection material change", () => {
    const view = render(
      <CadModel
        projection={BOTH_PROJECTION}
        selection={[{ kind: "body", bodyId: createBodyId("body_plate") }]}
      />,
    );
    const materials = [...view.container.querySelectorAll("meshstandardmaterial")];
    expect(materials.length).toBe(2);
    const highlighted = materials.filter(
      (material) => material.getAttribute("color") === "#f59e0b",
    );
    expect(highlighted.length).toBe(1);
    expect(highlighted[0]?.getAttribute("emissive")).toBe("#f59e0b");
    expect(highlighted[0]?.getAttribute("emissiveintensity")).toBe("0.35");
    // The unselected block keeps the documented defaults.
    const untouched = materials.find(
      (material) => material !== highlighted[0],
    );
    expect(untouched?.getAttribute("color")).toBe("#8aadf4");
    expect(untouched?.getAttribute("emissive")).toBeNull();
  });

  it("renders no highlight without a selection", () => {
    const { container } = renderModel(BOTH_PROJECTION);
    expect(container.querySelectorAll("mesh").length).toBe(2);
    expect(container.querySelector("meshbasicmaterial")).toBeNull();
  });
});
