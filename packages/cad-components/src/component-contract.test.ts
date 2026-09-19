/**
 * Component-contract validation tests (Phase 32.1): the contract
 * serializes and round-trips, the shipped definitions parse under it,
 * parameter exposure and validation behave per the documented codes, and
 * the definition → cad-core parameter-collection bridge is exact in both
 * directions. Malformed input is refused with the structured
 * `component-contract/*` codes — strict on known fields, tolerant of
 * unknown ones.
 */

import { describe, expect, it } from "vitest";
import {
  CANONICAL_UNITS,
  length,
  updateParameterValue,
} from "@slopcad/cad-core";
import type { CadComponent } from "./cad-component";

import {
  arduinoMount,
  ARDUINO_MOUNT_DEFAULT_PARAMETERS,
  ARDUINO_MOUNT_DEFINITION,
} from "./arduino-mount";
import {
  enclosure,
  ENCLOSURE_DEFAULT_PARAMETERS,
  ENCLOSURE_DEFINITION,
} from "./enclosure";
import {
  nema17Mount,
  NEMA17_MOUNT_DEFAULT_PARAMETERS,
  NEMA17_MOUNT_DEFINITION,
} from "./nema17-mount";
import {
  COMPONENT_CONTRACT_ERROR_CODES,
  COMPONENT_CONTRACT_VERSION,
  componentParameterCollection,
  componentParametersOfCollection,
  defaultParameterValues,
  isComponentParameterName,
  parameterValueOrDefault,
  parameterValuesOfCollection,
  parseComponentDefinition,
  resolveComponentParameters,
  serializeComponentDefinition,
} from "./component-contract";

/** The shipped Phase 32 components, for the phase-level checks. */
const SHIPPED: readonly CadComponent[] = [nema17Mount, arduinoMount, enclosure];

/** A minimal VALID definition every malformed-input case mutates. */
function validDefinition() {
  return {
    contractVersion: COMPONENT_CONTRACT_VERSION,
    id: "test-part",
    name: "Test part",
    description: "A minimal valid definition for mutation testing.",
    version: "1.2.3",
    parameters: [
      {
        name: "sizeMm",
        description: "The size.",
        dimension: "length",
        defaultValue: 10,
        min: 1,
        max: 100,
        step: 1,
      },
    ],
    ports: [{ name: "seat", description: "The seat.", kind: "interface" }],
    preview: {
      bodyIds: ["body_test-part"],
      viewport: { widthPx: 800, heightPx: 520 },
    },
  } satisfies Record<string, unknown>;
}

/** The valid definition's first parameter descriptor, mutation-ready. */
function firstParameter(
  base: ReturnType<typeof validDefinition>,
): Record<string, unknown> {
  return base.parameters[0] as Record<string, unknown>;
}

describe("component contract: serialization round-trip", () => {
  it("round-trips every shipped definition through serialize → parse → serialize", () => {
    for (const component of SHIPPED) {
      const once = serializeComponentDefinition(component.definition);
      const parsed = parseComponentDefinition(once);
      expect(parsed.ok, component.definition.id).toBe(true);
      if (!parsed.ok) continue;
      const twice = serializeComponentDefinition(parsed.value);
      expect(twice, component.definition.id).toEqual(once);
    }
  });

  it("serializes to canonical JSON-safe bytes (fixed key order, stable stringify)", () => {
    const serialized = serializeComponentDefinition(NEMA17_MOUNT_DEFINITION);
    expect(JSON.stringify(serialized)).toBe(
      JSON.stringify(serializeComponentDefinition(NEMA17_MOUNT_DEFINITION)),
    );
    expect(JSON.parse(JSON.stringify(serialized))).toEqual(serialized);
  });

  it("keeps the parsed definition's declared fields verbatim", () => {
    const parsed = parseComponentDefinition(
      serializeComponentDefinition(ARDUINO_MOUNT_DEFINITION),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.id).toBe(ARDUINO_MOUNT_DEFINITION.id);
    expect(parsed.value.name).toBe(ARDUINO_MOUNT_DEFINITION.name);
    expect(parsed.value.description).toBe(ARDUINO_MOUNT_DEFINITION.description);
    expect(parsed.value.version).toBe(ARDUINO_MOUNT_DEFINITION.version);
    expect(parsed.value.parameters).toEqual(
      ARDUINO_MOUNT_DEFINITION.parameters,
    );
    expect(parsed.value.ports).toEqual(ARDUINO_MOUNT_DEFINITION.ports);
    expect(parsed.value.preview).toEqual(ARDUINO_MOUNT_DEFINITION.preview);
  });

  it("tolerates unknown fields (a newer dialect deserializes without corruption)", () => {
    const extended = {
      ...validDefinition(),
      futureField: { anything: true },
    };
    const parsed = parseComponentDefinition(extended);
    expect(parsed.ok).toBe(true);
  });
});

describe("component contract: parse validation (structured refusals)", () => {
  it("refuses non-object input with malformed", () => {
    for (const input of [null, 41, "nope", [], () => {}]) {
      const parsed = parseComponentDefinition(input);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(
          COMPONENT_CONTRACT_ERROR_CODES.malformed,
        );
      }
    }
  });

  it("refuses a contract-version mismatch", () => {
    const parsed = parseComponentDefinition({
      ...validDefinition(),
      contractVersion: "2.0",
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe(
        COMPONENT_CONTRACT_ERROR_CODES.contractVersionMismatch,
      );
    }
  });

  it("refuses invalid ids (kebab-case rule)", () => {
    for (const id of [
      "",
      "UPPER",
      "1starts-digit",
      "has_underscore",
      "a".repeat(65),
    ]) {
      const parsed = parseComponentDefinition({ ...validDefinition(), id });
      expect(parsed.ok, `id ${id}`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(
          COMPONENT_CONTRACT_ERROR_CODES.idInvalid,
        );
      }
    }
  });

  it("refuses invalid versions (semver rule)", () => {
    for (const version of ["1", "1.2", "v1.2.3", "1.2.3.4", ""]) {
      const parsed = parseComponentDefinition({
        ...validDefinition(),
        version,
      });
      expect(parsed.ok, `version ${version}`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(
          COMPONENT_CONTRACT_ERROR_CODES.versionInvalid,
        );
      }
    }
  });

  it("refuses absent/empty display names and descriptions", () => {
    for (const field of ["name", "description"]) {
      for (const value of [undefined, "", "   "]) {
        const mutated: Record<string, unknown> = { ...validDefinition() };
        if (value === undefined) delete mutated[field];
        else mutated[field] = value;
        const parsed = parseComponentDefinition(mutated);
        expect(parsed.ok, `${field}=${String(value)}`).toBe(false);
        if (!parsed.ok) {
          expect(parsed.error.code).toBe(
            COMPONENT_CONTRACT_ERROR_CODES.descriptionInvalid,
          );
        }
      }
    }
  });

  it("refuses empty parameter lists and duplicate parameter names", () => {
    const empty = parseComponentDefinition({
      ...validDefinition(),
      parameters: [],
    });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
      );
    }

    const base = validDefinition();
    const descriptor = firstParameter(base);
    const duplicated = parseComponentDefinition({
      ...base,
      parameters: [descriptor, { ...descriptor }],
    });
    expect(duplicated.ok).toBe(false);
    if (!duplicated.ok) {
      expect(duplicated.error.code).toBe(
        COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
      );
    }
  });

  it("refuses parameter names a cad-core parameter could not carry", () => {
    for (const name of ["", "with space", "2fast", "sqrt", "min", "max"]) {
      const base = validDefinition();
      const descriptor = firstParameter(base);
      const parsed = parseComponentDefinition({
        ...base,
        parameters: [{ ...descriptor, name }],
      });
      expect(parsed.ok, `name ${name}`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(
          COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        );
      }
    }
  });

  it("refuses non-finite defaults, bad dimensions, min>max, bad steps, and out-of-bounds defaults", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["defaultValue", Number.POSITIVE_INFINITY],
      ["dimension", "warp"],
      ["dimension", 7],
      ["min", "small"],
      ["max", Number.NaN],
      ["step", 0],
      ["step", -1],
      ["min", 500],
    ];
    for (const [field, value] of cases) {
      const base = validDefinition();
      const descriptor = firstParameter(base);
      descriptor[field] = value;
      const parsed = parseComponentDefinition(base);
      expect(parsed.ok, `${field}=${String(value)}`).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error.code).toBe(
          COMPONENT_CONTRACT_ERROR_CODES.parameterInvalid,
        );
      }
    }
  });

  it("refuses bad ports: wrong kinds, duplicates, bad names", () => {
    const base = validDefinition();
    const port = (base.ports as Record<string, unknown>[])[0];
    const kindCase = parseComponentDefinition({
      ...base,
      ports: [{ ...port, kind: "flange" }],
    });
    expect(kindCase.ok).toBe(false);
    if (!kindCase.ok) {
      expect(kindCase.error.code).toBe(
        COMPONENT_CONTRACT_ERROR_CODES.portInvalid,
      );
    }

    const duplicateCase = parseComponentDefinition({
      ...base,
      ports: [port, { ...port }],
    });
    expect(duplicateCase.ok).toBe(false);

    const nameCase = parseComponentDefinition({
      ...base,
      ports: [{ ...port, name: "not an identifier" }],
    });
    expect(nameCase.ok).toBe(false);
  });

  it("refuses bad preview metadata: empty/duplicate bodyIds, out-of-range viewports", () => {
    const base = validDefinition();
    const emptyIds = parseComponentDefinition({
      ...base,
      preview: { ...base.preview, bodyIds: [] },
    });
    expect(emptyIds.ok).toBe(false);
    if (!emptyIds.ok) {
      expect(emptyIds.error.code).toBe(
        COMPONENT_CONTRACT_ERROR_CODES.previewInvalid,
      );
    }

    const duplicatedIds = parseComponentDefinition({
      ...base,
      preview: {
        ...base.preview,
        bodyIds: ["body_a", "body_a"],
      },
    });
    expect(duplicatedIds.ok).toBe(false);

    const badViewport = parseComponentDefinition({
      ...base,
      preview: {
        ...base.preview,
        viewport: { widthPx: 32, heightPx: 520 },
      },
    });
    expect(badViewport.ok).toBe(false);

    const fractionalViewport = parseComponentDefinition({
      ...base,
      preview: {
        ...base.preview,
        viewport: { widthPx: 800.5, heightPx: 520 },
      },
    });
    expect(fractionalViewport.ok).toBe(false);
  });
});

describe("component contract: parameter exposure and validation", () => {
  it("exposes every shipped component's parameters with consistent metadata", () => {
    for (const component of SHIPPED) {
      const { parameters } = component.definition;
      expect(parameters.length, component.definition.id).toBeGreaterThan(0);
      for (const parameter of parameters) {
        expect(isComponentParameterName(parameter.name)).toBe(true);
        expect(parameter.description.length).toBeGreaterThan(0);
        expect(CANONICAL_UNITS[parameter.dimension]).toBeDefined();
        expect(Number.isFinite(parameter.defaultValue)).toBe(true);
        expect(parameter.dimension).toBe("length");
        if (parameter.min !== undefined) {
          expect(parameter.min).toBeLessThanOrEqual(parameter.defaultValue);
        }
        if (parameter.max !== undefined) {
          expect(parameter.max).toBeGreaterThanOrEqual(parameter.defaultValue);
        }
        if (parameter.step !== undefined) {
          expect(parameter.step).toBeGreaterThan(0);
        }
      }
      // Unique names per component.
      expect(new Set(parameters.map((p) => p.name)).size).toBe(
        parameters.length,
      );
    }
  });

  it("defaults equal the typed default literals, name for name", () => {
    expect(defaultParameterValues(NEMA17_MOUNT_DEFINITION)).toEqual(
      NEMA17_MOUNT_DEFAULT_PARAMETERS,
    );
    expect(defaultParameterValues(ARDUINO_MOUNT_DEFINITION)).toEqual(
      ARDUINO_MOUNT_DEFAULT_PARAMETERS,
    );
    expect(defaultParameterValues(ENCLOSURE_DEFINITION)).toEqual(
      ENCLOSURE_DEFAULT_PARAMETERS,
    );
  });

  it("resolves a complete in-bounds submission and reads it back", () => {
    const resolved = resolveComponentParameters(
      NEMA17_MOUNT_DEFINITION,
      NEMA17_MOUNT_DEFAULT_PARAMETERS,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.names).toEqual(
      NEMA17_MOUNT_DEFINITION.parameters.map((p) => p.name),
    );
    expect(resolved.value.get("plateSizeMm")).toBe(46);
    expect(resolved.value.values).toEqual(NEMA17_MOUNT_DEFAULT_PARAMETERS);
  });

  it("accepts inclusive boundary values", () => {
    const resolved = resolveComponentParameters(NEMA17_MOUNT_DEFINITION, {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      plateSizeMm: 30,
      boreDiameterMm: 60,
    });
    // ⌀60 + 2 mm wall exceeds the 30 mm plate — the CONTRACT resolves it
    // (bounds-only discipline); the component's own conflict check refuses.
    expect(resolved.ok).toBe(true);
  });

  it("refuses missing, non-finite, and out-of-range values (parameterOutOfRange)", () => {
    for (const values of [
      {},
      { ...NEMA17_MOUNT_DEFAULT_PARAMETERS, plateSizeMm: Number.NaN },
      { ...NEMA17_MOUNT_DEFAULT_PARAMETERS, plateSizeMm: 29.9 },
      { ...NEMA17_MOUNT_DEFAULT_PARAMETERS, plateSizeMm: 91 },
    ]) {
      const resolved = resolveComponentParameters(
        NEMA17_MOUNT_DEFINITION,
        values,
      );
      expect(resolved.ok, JSON.stringify(values)).toBe(false);
      if (!resolved.ok) {
        expect(resolved.error.code).toBe(
          COMPONENT_CONTRACT_ERROR_CODES.parameterOutOfRange,
        );
      }
    }
  });

  it("refuses unknown parameter names (renamed/typo guard)", () => {
    const resolved = resolveComponentParameters(NEMA17_MOUNT_DEFINITION, {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      plateSize: 46,
    });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe(
        COMPONENT_CONTRACT_ERROR_CODES.unknownParameter,
      );
    }
  });

  it("parameterValueOrDefault is the total metadata view (default on malformed)", () => {
    expect(
      parameterValueOrDefault(
        NEMA17_MOUNT_DEFINITION,
        { plateSizeMm: 52 },
        "plateSizeMm",
      ),
    ).toBe(52);
    expect(
      parameterValueOrDefault(
        NEMA17_MOUNT_DEFINITION,
        { plateSizeMm: Number.NaN },
        "plateSizeMm",
      ),
    ).toBe(46);
    expect(
      parameterValueOrDefault(NEMA17_MOUNT_DEFINITION, {}, "holeSpacingMm"),
    ).toBe(31);
  });
});

describe("component contract: the cad-core parameter-collection bridge", () => {
  it("builds a collection whose parameters mirror the descriptors", () => {
    const collection = componentParameterCollection(
      ARDUINO_MOUNT_DEFINITION,
      ARDUINO_MOUNT_DEFAULT_PARAMETERS,
    );
    expect(collection.ok).toBe(true);
    if (!collection.ok) return;
    const parameters = collection.value.parameters;
    expect(parameters.map((p) => p.name)).toEqual(
      ARDUINO_MOUNT_DEFINITION.parameters.map((p) => p.name),
    );
    for (const parameter of parameters) {
      expect(parameter.expression).toBeNull();
      expect(parameter.value).toEqual(length(parameter.value.value));
      expect(parameter.metadata.componentId).toBe(ARDUINO_MOUNT_DEFINITION.id);
      const descriptor = ARDUINO_MOUNT_DEFINITION.parameters.find(
        (p) => p.name === parameter.name,
      );
      expect(descriptor).toBeDefined();
      if (descriptor?.min !== undefined) {
        expect(parameter.metadata.min).toBe(descriptor.min);
      }
      if (descriptor?.step !== undefined) {
        expect(parameter.metadata.step).toBe(descriptor.step);
      }
    }
  });

  it("round-trips values through the collection (values → collection → values)", () => {
    const edited = { ...ENCLOSURE_DEFAULT_PARAMETERS, innerWidthMm: 90 };
    const collection = componentParameterCollection(
      ENCLOSURE_DEFINITION,
      edited,
    );
    expect(collection.ok).toBe(true);
    if (!collection.ok) return;
    expect(
      parameterValuesOfCollection(ENCLOSURE_DEFINITION, collection.value),
    ).toEqual(edited);
  });

  it("reads an authored-unit edit back in canonical units (panel edit path)", () => {
    const collection = componentParameterCollection(
      ENCLOSURE_DEFINITION,
      ENCLOSURE_DEFAULT_PARAMETERS,
    );
    expect(collection.ok).toBe(true);
    if (!collection.ok) return;
    const parameter = collection.value.parameters.find(
      (candidate) => candidate.name === "innerWidthMm",
    );
    expect(parameter).toBeDefined();
    if (parameter === undefined) return;
    // A panel edit stores the value in its authored unit: 6 cm. The
    // read-back must be the canonical magnitude (60 mm), not 6.
    const edited = updateParameterValue(
      collection.value,
      parameter.id,
      length(6, "cm"),
    );
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(
      parameterValuesOfCollection(ENCLOSURE_DEFINITION, edited.value)
        .innerWidthMm,
    ).toBe(60);
  });

  it("filters a collection down to one definition's parameters", () => {
    const collection = componentParameterCollection(
      NEMA17_MOUNT_DEFINITION,
      NEMA17_MOUNT_DEFAULT_PARAMETERS,
    );
    expect(collection.ok).toBe(true);
    if (!collection.ok) return;
    const mine = componentParametersOfCollection(
      NEMA17_MOUNT_DEFINITION,
      collection.value,
    );
    expect(mine.map((p) => p.name)).toEqual(
      NEMA17_MOUNT_DEFINITION.parameters.map((p) => p.name),
    );
  });

  it("surfaces contract failures as the domain's parameter-error shape", () => {
    const collection = componentParameterCollection(NEMA17_MOUNT_DEFINITION, {
      ...NEMA17_MOUNT_DEFAULT_PARAMETERS,
      plateSizeMm: 500,
    });
    expect(collection.ok).toBe(false);
    if (!collection.ok) {
      expect(collection.error.code).toBeDefined();
      expect(collection.error.message).toContain("plateSizeMm");
    }
  });
});
