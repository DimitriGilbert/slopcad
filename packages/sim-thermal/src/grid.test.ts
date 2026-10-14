/**
 * The cell-grid classification pins (law S3's consumer mapping): the
 * direct node→cell interpretation, the exterior flood fill, the
 * enclosure (sealed-cavity) detection the §7.12 exchange keys on, the
 * exposed-face enumeration with honest areas, and the loud declines.
 */

import { describe, expect, it } from "vitest";
import { SIM_ERROR_CODES, type SimOccupancyGrid } from "@slopcad/sim-core";

import {
  THERMAL_FACE_DIRECTIONS,
  thermalCellGrid,
  thermalDomainFaceOfDirection,
  thermalExposedFaces,
} from "./grid";
import { analyticGrid, boxGrid, shellGrid } from "./fixtures";

describe("thermalCellGrid", () => {
  it("classifies a fully solid box: no exterior, no enclosures", () => {
    const classified = thermalCellGrid(boxGrid([0, 0, 0], [4, 4, 4], 0.001));
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value.solid.every((value) => value === 1)).toBe(true);
    expect(classified.value.exterior.every((value) => value === 0)).toBe(true);
    expect(classified.value.enclosureCount).toBe(0);
    expect(classified.value.cellVolumeM3).toBeCloseTo(1e-9, 15);
  });

  it("detects the sealed cavity of a shell as exactly one enclosure", () => {
    // 7³ shell, cavity = cells 2..4 on every axis (3³ = 27 cells).
    const classified = thermalCellGrid(shellGrid(7, 2, 4, 0.005));
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    const grid = classified.value;
    expect(grid.enclosureCount).toBe(1);
    let cavityCells = 0;
    for (let cell = 0; cell < grid.cavityOf.length; cell += 1) {
      if ((grid.cavityOf[cell] ?? -1) >= 0) cavityCells += 1;
    }
    expect(cavityCells).toBe(27);
    // A sealed cavity is NOT exterior.
    expect(grid.exterior.every((value) => value === 0)).toBe(true);
  });

  it("floods an OPEN cavity to the exterior — a vented shell has no enclosure", () => {
    // Same shell with a two-cell vent tunnelled through the wall along
    // +x at (j, k) = (3, 3): the cavity connects to the domain boundary.
    const vented = analyticGrid([7, 7, 7], 0.005, (i, j, k) => {
      if (j === 3 && k === 3 && (i === 0 || i === 1)) return false;
      const insideCavity =
        i >= 2 && i <= 4 && j >= 2 && j <= 4 && k >= 2 && k <= 4;
      return !insideCavity;
    });
    const classified = thermalCellGrid(vented);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value.enclosureCount).toBe(0);
    let exteriorCells = 0;
    for (let cell = 0; cell < classified.value.exterior.length; cell += 1) {
      if (classified.value.exterior[cell] === 1) exteriorCells += 1;
    }
    // 27 cavity cells + the 2-cell vent tunnel = 29 fluid, all exterior.
    expect(exteriorCells).toBe(29);
  });

  it("classifies a body floating in a larger domain: all fluid is exterior", () => {
    // A 4³ box at cells 1..4 inside a 6³ domain — nowhere touching the
    // box boundary.
    const floating = analyticGrid(
      [6, 6, 6],
      0.002,
      (i, j, k) => i >= 1 && i <= 4 && j >= 1 && j <= 4 && k >= 1 && k <= 4,
    );
    const classified = thermalCellGrid(floating);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    expect(classified.value.enclosureCount).toBe(0);
    let exterior = 0;
    for (let cell = 0; cell < classified.value.exterior.length; cell += 1) {
      if (classified.value.exterior[cell] === 1) exterior += 1;
    }
    expect(exterior).toBe(6 ** 3 - 4 ** 3);
  });

  it("declines non-binary cells and count mismatches with the grid discipline", () => {
    const bad: SimOccupancyGrid = {
      semantic: "occupancy",
      name: "bad",
      shape: [2, 2, 1],
      originM: [0, 0, 0],
      spacingM: [1, 1, 1],
      cells: Uint8Array.from([0, 2, 1, 0]),
    };
    const classified = thermalCellGrid(bad);
    expect(classified.ok).toBe(false);
    if (classified.ok) return;
    expect(classified.error.code).toBe(SIM_ERROR_CODES.gridFieldMalformed);

    const short: SimOccupancyGrid = {
      semantic: "occupancy",
      name: "short",
      shape: [2, 2, 1],
      originM: [0, 0, 0],
      spacingM: [1, 1, 1],
      cells: Uint8Array.from([0, 1, 1]),
    };
    expect(thermalCellGrid(short).ok).toBe(false);
  });
});

describe("thermalExposedFaces", () => {
  it("enumerates a floating box's surface as ambient faces with exact areas", () => {
    const floating = analyticGrid(
      [6, 6, 6],
      0.002,
      (i, j, k) => i >= 1 && i <= 4 && j >= 1 && j <= 4 && k >= 1 && k <= 4,
    );
    const classified = thermalCellGrid(floating);
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    const faces = thermalExposedFaces(classified.value);
    // The 4³ box has 6·16 = 96 surface faces, all facing exterior fluid.
    expect(faces.length).toBe(96);
    expect(faces.every((face) => face.kind === "ambient")).toBe(true);
    expect(faces[0]?.areaM2).toBeCloseTo(0.002 * 0.002, 15);
  });

  it("splits a shell's faces into domain and enclosure faces", () => {
    const classified = thermalCellGrid(shellGrid(7, 2, 4, 0.005));
    expect(classified.ok).toBe(true);
    if (!classified.ok) return;
    const faces = thermalExposedFaces(classified.value);
    const domain = faces.filter((face) => face.kind === "domain");
    const enclosure = faces.filter((face) => face.kind === "enclosure");
    // Outer surface: 6 · 49 = 294 box-boundary faces; cavity walls:
    // 6 · 9 = 54 faces of the 3³ cavity.
    expect(domain.length).toBe(294);
    expect(enclosure.length).toBe(54);
    expect(enclosure.every((face) => face.enclosure === 0)).toBe(true);
  });

  it("keeps the direction vocabulary and face mapping fixed", () => {
    expect(THERMAL_FACE_DIRECTIONS.length).toBe(6);
    expect(thermalDomainFaceOfDirection(0, -1)).toBe("xMin");
    expect(thermalDomainFaceOfDirection(0, 1)).toBe("xMax");
    expect(thermalDomainFaceOfDirection(1, -1)).toBe("yMin");
    expect(thermalDomainFaceOfDirection(1, 1)).toBe("yMax");
    expect(thermalDomainFaceOfDirection(2, -1)).toBe("zMin");
    expect(thermalDomainFaceOfDirection(2, 1)).toBe("zMax");
  });
});
