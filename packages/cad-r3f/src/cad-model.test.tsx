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
import { Plane, MeshStandardMaterial } from "three";
import { afterEach, describe, expect, it } from "vitest";
import { createBodyId } from "@slopcad/cad-core";
import type {
  RenderObject,
  RenderObjectId,
  RenderProjection,
  SelectionReference,
} from "@slopcad/cad-core";
import type { RenderGeometrySnapshot } from "./geometry";

import { CadModel } from "./cad-model";
import {
  FOLDED_SHEET_SHARED,
  makeObject,
  makeProjection,
} from "./render-fixtures";

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
    <CadModel
      projection={projection}
      onSync={(snapshot) => snapshots.push(snapshot)}
    />,
  );
  return {
    container: view.container,
    snapshots,
    rerender: (next) =>
      view.rerender(
        <CadModel
          projection={next}
          onSync={(snapshot) => snapshots.push(snapshot)}
        />,
      ),
    unmount: view.unmount,
  };
}

function geometryOf(
  snapshot: RenderGeometrySnapshot,
  id: RenderObjectId,
): THREE.BufferGeometry {
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
      expect(material?.getAttribute("color")).toBe("#aabdd6");
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
    const { container, snapshots, rerender, unmount } =
      renderModel(BOTH_PROJECTION);
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

  it("skips a face highlight that crosses geometry generations, then rebuilds it after the flush", () => {
    // The plate's single coplanar synthetic face spans triangles 0..1 in the
    // grown projection; the lagging base snapshot from the first projection
    // holds one triangle's 3 indices. The highlights memo runs during that
    // crossed-generation render — indexing the new grouping into the stale
    // base must skip the overlay (a render-phase crash without the guard),
    // and the geometry effect's flush rebuilds it from the matching base.
    const triangle = makeObject("plate", {
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
      indices: [0, 1, 2],
    });
    const quad = makeObject("plate", {
      positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
      indices: [0, 1, 2, 0, 2, 3],
    });
    const selection: readonly SelectionReference[] = [
      {
        kind: "face",
        bodyId: createBodyId("body_plate"),
        regeneration: 5,
        faceIndex: 0,
      },
    ];
    const view = render(
      <CadModel
        projection={makeProjection([triangle])}
        regeneration={5}
        selection={selection}
      />,
    );
    // One base mesh plus the one-face highlight from the matching base.
    expect(view.container.querySelectorAll("mesh").length).toBe(2);
    // The crossed-generation commit: rerender throws out of useMemo if the
    // guard is missing, and otherwise lands with the overlay rebuilt.
    view.rerender(
      <CadModel
        projection={makeProjection([quad])}
        regeneration={5}
        selection={selection}
      />,
    );
    const highlight = view.container.querySelector('mesh[renderorder="1"]');
    expect(highlight).not.toBeNull();
    const highlightMaterial = highlight?.querySelector("meshbasicmaterial");
    expect(highlightMaterial?.getAttribute("color")).toBe("#f59e0b");
    // Exactly one base mesh and one rebuilt highlight.
    expect(view.container.querySelectorAll("mesh").length).toBe(2);
  });

  it("applies the documented body-selection material change", () => {
    const view = render(
      <CadModel
        projection={BOTH_PROJECTION}
        selection={[{ kind: "body", bodyId: createBodyId("body_plate") }]}
      />,
    );
    const materials = [
      ...view.container.querySelectorAll("meshstandardmaterial"),
    ];
    expect(materials.length).toBe(2);
    const highlighted = materials.filter(
      (material) => material.getAttribute("color") === "#f59e0b",
    );
    expect(highlighted.length).toBe(1);
    expect(highlighted[0]?.getAttribute("emissive")).toBe("#f59e0b");
    expect(highlighted[0]?.getAttribute("emissiveintensity")).toBe("0.35");
    // The unselected block keeps the documented defaults.
    const untouched = materials.find((material) => material !== highlighted[0]);
    expect(untouched?.getAttribute("color")).toBe("#aabdd6");
    expect(untouched?.getAttribute("emissive")).toBeNull();
  });

  it("highlights a body selection for a bodyId-less render object through the id-derived fallback", () => {
    // Renderer-owned objects may omit `bodyId` (projection contract); the
    // pick resolver derives it from the render object id (totality contract
    // pinned in picking.test.ts), and the body highlight must agree — a
    // body pick that resolves must also highlight.
    const anonymous: RenderObject = { ...PLATE, bodyId: undefined };
    const view = render(
      <CadModel
        projection={makeProjection([anonymous])}
        selection={[{ kind: "body", bodyId: createBodyId("body_plate") }]}
      />,
    );
    const materials = [
      ...view.container.querySelectorAll("meshstandardmaterial"),
    ];
    expect(materials.length).toBe(1);
    expect(materials[0]?.getAttribute("color")).toBe("#f59e0b");
    expect(materials[0]?.getAttribute("emissive")).toBe("#f59e0b");
    expect(materials[0]?.getAttribute("emissiveintensity")).toBe("0.35");
  });

  it("renders no highlight without a selection", () => {
    const { container } = renderModel(BOTH_PROJECTION);
    expect(container.querySelectorAll("mesh").length).toBe(2);
    expect(container.querySelector("meshbasicmaterial")).toBeNull();
  });
});

describe("CadModel display modes (Phase 45)", () => {
  // The mode -> write-mask decisions are pinned on the pure table
  // (`display-mode.test.ts`); React surfaces no boolean props on these
  // custom elements, so the component level asserts what IS observable
  // without a WebGL reconciler: the feature-edge overlay's mount,
  // per-object count, ink, and lifecycle across mode changes.
  it("shaded (the default): no edge overlay", () => {
    const { container, unmount } = renderModel(BOTH_PROJECTION);
    expect(container.querySelectorAll("linesegments").length).toBe(0);
    unmount();
  });

  it("shaded-edges mounts one edge overlay per object with the documented ink", () => {
    const view = render(
      <CadModel projection={BOTH_PROJECTION} displayMode="shaded-edges" />,
    );
    const edges = view.container.querySelectorAll("linesegments");
    expect(edges.length).toBe(2);
    const ink = view.container.querySelector("linebasicmaterial");
    expect(ink?.getAttribute("color")).toBe("#d8e2f2");
    view.unmount();
  });

  it("wireframe and hidden-line mount the edge overlay too (surfaces stay mounted)", () => {
    for (const mode of ["wireframe", "hidden-line"] as const) {
      const view = render(
        <CadModel projection={BOTH_PROJECTION} displayMode={mode} />,
      );
      expect(view.container.querySelectorAll("mesh").length).toBe(2);
      expect(view.container.querySelectorAll("linesegments").length).toBe(2);
      view.unmount();
    }
  });

  it("a mode change onto shaded unmounts the overlay entirely", () => {
    const view = render(
      <CadModel projection={BOTH_PROJECTION} displayMode="shaded-edges" />,
    );
    expect(view.container.querySelectorAll("linesegments").length).toBe(2);
    view.rerender(
      <CadModel projection={BOTH_PROJECTION} displayMode="shaded" />,
    );
    expect(view.container.querySelectorAll("linesegments").length).toBe(0);
    view.unmount();
  });
});

describe("CadModel section clipping material law (Phase 46)", () => {
  // The boot-raster law's material-construction half: the material host
  // prop is ALWAYS defined (empty-but-present when nothing clips), and an
  // empty value constructs a material byte-identical to one built without
  // the prop at all. The prop must never be REMOVED by a state transition
  // — R3F's removed-prop reset writes a literal `0` for classes whose
  // constructor takes parameters (`MeshStandardMaterial`'s does), which
  // poisons `material.clippingPlanes` and kills the mesh's draw (the
  // Phase 46 empty-canvas regression).
  const materialHost = (container: HTMLElement): Element => {
    const host = container.querySelector("meshstandardmaterial");
    if (host === null) throw new Error("expected a material host element");
    return host;
  };

  it("keeps the clipping host prop defined for absent, empty, and live planes", () => {
    const absent = render(<CadModel projection={BOTH_PROJECTION} />);
    expect(materialHost(absent.container).getAttribute("clippingplanes")).toBe(
      "",
    );
    absent.unmount();

    const empty = render(
      <CadModel projection={BOTH_PROJECTION} clippingPlanes={[]} />,
    );
    expect(materialHost(empty.container).getAttribute("clippingplanes")).toBe(
      "",
    );
    empty.unmount();

    const clipped = render(
      <CadModel projection={BOTH_PROJECTION} clippingPlanes={[new Plane()]} />,
    );
    expect(
      materialHost(clipped.container).getAttribute("clippingplanes"),
    ).not.toBe("");
    clipped.unmount();
  });

  it("constructs byte-identical materials for empty-but-defined and absent clipping planes", () => {
    // three's local-clipping contract (WebGLClipping.setState): a null
    // value and an empty array both name NO clipping, so the program and
    // uniform state a frame builds from either material are identical.
    const absent = new MeshStandardMaterial({
      color: "#aabdd6",
      metalness: 0.15,
      roughness: 0.55,
    });
    const emptyDefined = new MeshStandardMaterial({
      color: "#aabdd6",
      metalness: 0.15,
      roughness: 0.55,
      clippingPlanes: [],
    });
    const serializable = (material: MeshStandardMaterial): unknown => {
      const record = material.toJSON() as unknown as Record<string, unknown>;
      delete record.uuid;
      delete record.metadata;
      return record;
    };
    expect(
      absent.clippingPlanes === null || absent.clippingPlanes.length === 0,
    ).toBe(true);
    expect(emptyDefined.clippingPlanes).toEqual([]);
    // Byte-identical construction: the same serializable material state
    // and the same version (no needsUpdate pressure the always-apply
    // path would introduce — that divergence goes red here).
    expect(serializable(emptyDefined)).toEqual(serializable(absent));
    expect(emptyDefined.version).toBe(absent.version);
  });
});
