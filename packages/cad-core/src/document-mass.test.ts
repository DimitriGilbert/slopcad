/**
 * Document mass properties tests (Phase 58): the unit law (g/cm³ over
 * mm³), the mass-weighted COG on a two-box compound at offsets, and the
 * structured refusals the consumer layer owes — unassigned, unknown,
 * zero-mass, malformed.
 */

import { describe, expect, it } from "vitest";

import {
  documentMassProperties,
  DOCUMENT_MASS_ERROR_CODES,
  parseMaterialId,
  type DocumentMaterialRecord,
  type MassContribution,
} from "./index";

/** Parses or throws — the fixture's ids are known-good. */
function mustMaterial(raw: string): DocumentMaterialRecord["id"] {
  const parsed = parseMaterialId(raw);
  if (!parsed.ok) throw new Error(`expected ${raw} to parse`);
  return parsed.value;
}

const RECORDS: DocumentMaterialRecord[] = [
  {
    id: mustMaterial("mat_aluminium"),
    name: "Aluminium",
    densityGPerCm3: 2.7,
  },
  {
    id: mustMaterial("mat_steel"),
    name: "Steel",
    densityGPerCm3: 7.85,
  },
];

function materialOf(
  materialId: Parameters<typeof parseMaterialId>[0],
): DocumentMaterialRecord | undefined {
  return RECORDS.find((record) => record.id === materialId);
}

describe("document mass properties", () => {
  it("applies the unit law exactly: 1000 mm³ of water weighs 1 gram", () => {
    const water = parseMaterialId("mat_water");
    expect(water.ok).toBe(true);
    if (!water.ok) return;
    const report = documentMassProperties({
      contributions: [
        {
          path: ["occ_water"],
          materialId: water.value,
          volumeMm3: 1000,
          centroid: [0, 0, 0],
        },
      ],
      materialOf: (id) =>
        id === water.value
          ? { id: water.value, name: "Water", densityGPerCm3: 1 }
          : undefined,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.massGrams).toBe(1);
  });

  it("aggregates a two-box compound at offsets with its mass-weighted COG", () => {
    const aluminium = parseMaterialId("mat_aluminium");
    const steel = parseMaterialId("mat_steel");
    expect(aluminium.ok && steel.ok).toBe(true);
    if (!aluminium.ok || !steel.ok) return;
    const contributions: MassContribution[] = [
      {
        path: ["occ_mass_plate"],
        materialId: aluminium.value,
        volumeMm3: 28800,
        centroid: [30, 20, 6],
      },
      {
        path: ["occ_mass_cube"],
        materialId: steel.value,
        volumeMm3: 27000,
        centroid: [15, 15, 55],
      },
    ];
    const report = documentMassProperties({
      contributions,
      materialOf,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    // plate: 2.7 × 28800 / 1000 = 77.76 g; cube: 7.85 × 27000 / 1000 = 211.95 g.
    expect(report.value.massGrams).toBeCloseTo(289.71, 9);
    const [plate, cube] = report.value.contributions;
    expect(plate?.massGrams).toBeCloseTo(77.76, 9);
    expect(cube?.massGrams).toBeCloseTo(211.95, 9);
    // COG = (77.76·(30,20,6) + 211.95·(15,15,55)) / 289.71.
    const cog = report.value.centerOfGravity;
    expect(cog[0]).toBeCloseTo((77.76 * 30 + 211.95 * 15) / 289.71, 9);
    expect(cog[1]).toBeCloseTo((77.76 * 20 + 211.95 * 15) / 289.71, 9);
    expect(cog[2]).toBeCloseTo((77.76 * 6 + 211.95 * 55) / 289.71, 9);
  });

  it("declines unassigned-volume lies only through structured codes", () => {
    const aluminium = parseMaterialId("mat_aluminium");
    expect(aluminium.ok).toBe(true);
    if (!aluminium.ok) return;

    const unknown = documentMassProperties({
      contributions: [
        {
          path: ["occ_x"],
          materialId: mustMaterial("mat_unobtanium"),
          volumeMm3: 100,
          centroid: [0, 0, 0],
        },
      ],
      materialOf,
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_MASS_ERROR_CODES.unknownMaterial },
    });

    const malformed = documentMassProperties({
      contributions: [
        {
          path: [],
          materialId: aluminium.value,
          volumeMm3: 100,
          centroid: [0, 0, 0],
        },
      ],
      materialOf,
    });
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_MASS_ERROR_CODES.malformed },
    });

    const zeroMass = documentMassProperties({
      contributions: [],
      materialOf,
    });
    expect(zeroMass).toMatchObject({
      ok: false,
      error: { code: DOCUMENT_MASS_ERROR_CODES.zeroMass },
    });
  });

  it("validates the material id prefix at the trust boundary", () => {
    expect(parseMaterialId("mat_steel").ok).toBe(true);
    expect(parseMaterialId("steel")).toMatchObject({ ok: false });
    expect(parseMaterialId("")).toMatchObject({ ok: false });
  });
});
