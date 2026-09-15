import { describe, expect, it } from "vitest";

import {
  ANGLE_UNITS,
  AREA_UNITS,
  type AnyUnit,
  CANONICAL_UNITS,
  type Dimension,
  DIMENSIONS,
  DIMENSIONLESS_UNIT,
  isUnitToken,
  LENGTH_UNITS,
  parseUnit,
  unitDimension,
  VOLUME_UNITS,
} from "./index";

const TOKEN_DIMENSIONS: readonly (readonly [AnyUnit, Dimension])[] = [
  ["mm", "length"],
  ["cm", "length"],
  ["m", "length"],
  ["in", "length"],
  ["deg", "angle"],
  ["rad", "angle"],
  ["mm2", "area"],
  ["cm2", "area"],
  ["m2", "area"],
  ["in2", "area"],
  ["mm3", "volume"],
  ["cm3", "volume"],
  ["m3", "volume"],
  ["in3", "volume"],
  ["1", "dimensionless"],
];

describe("unit registry", () => {
  it("defines the documented unit tokens per dimension", () => {
    expect(DIMENSIONS).toEqual([
      "length",
      "angle",
      "area",
      "volume",
      "dimensionless",
    ]);
    expect(LENGTH_UNITS).toEqual(["mm", "cm", "m", "in"]);
    expect(ANGLE_UNITS).toEqual(["deg", "rad"]);
    expect(AREA_UNITS).toEqual(["mm2", "cm2", "m2", "in2"]);
    expect(VOLUME_UNITS).toEqual(["mm3", "cm3", "m3", "in3"]);
    expect(DIMENSIONLESS_UNIT).toBe("1");
  });

  it("keeps unit tokens distinct across dimensions", () => {
    const tokens = [
      ...LENGTH_UNITS,
      ...ANGLE_UNITS,
      ...AREA_UNITS,
      ...VOLUME_UNITS,
      DIMENSIONLESS_UNIT,
    ];
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it("keeps exactly one canonical unit per dimension", () => {
    expect(CANONICAL_UNITS).toEqual({
      length: "mm",
      angle: "rad",
      area: "mm2",
      volume: "mm3",
      dimensionless: "1",
    });
  });

  it("classifies every unit token by its dimension", () => {
    for (const [unit, dimension] of TOKEN_DIMENSIONS) {
      expect(isUnitToken(unit)).toBe(true);
      expect(unitDimension(unit)).toBe(dimension);
    }
    expect(isUnitToken("km")).toBe(false);
    expect(isUnitToken("")).toBe(false);
    expect(isUnitToken(42)).toBe(false);
    expect(isUnitToken(null)).toBe(false);
  });
});

describe("parseUnit", () => {
  it("parses every known token together with its dimension", () => {
    for (const [unit, dimension] of TOKEN_DIMENSIONS) {
      const result = parseUnit(unit);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({ unit, dimension });
      }
    }
  });

  it("rejects non-string input with unit/not-a-string", () => {
    for (const input of [null, undefined, 42, true, {}, ["mm"]]) {
      const result = parseUnit(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unit/not-a-string");
        expect(result.error.input).toBe(input);
      }
    }
  });

  it("rejects unknown unit tokens with unit/unknown", () => {
    for (const input of [
      "",
      "km",
      "ft",
      "MM",
      "in²",
      " mm",
      "sq mm",
      "mm2extra",
    ]) {
      const result = parseUnit(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("unit/unknown");
        expect(result.error.input).toBe(input);
      }
    }
  });
});
