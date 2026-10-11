/**
 * Scenario cross-compatibility pins (Phase 61): sim-core's restatement of
 * the document model's scenario vocabulary (`SIM_CORE_SCENARIO_KINDS` /
 * `SIM_CORE_DOMAIN_FACES` after `@slopcad/cad-core`'s
 * `SIM_SCENARIO_KINDS` / `SIM_DOMAIN_FACES`) is only honest while the two
 * stay pinned — this suite fails the moment they drift. The condition and
 * backend vocabularies have no restated sim-core arrays (the compile
 * boundary re-validates them structurally), so they are pinned behaviorally:
 * every condition kind the document may store compiles — or declines by the
 * structural carve, never as wire-invalid — and both backend preferences
 * survive the boundary. The cad-core package is a dev-only import: it
 * appears in no runtime graph of sim-core, exactly as the kernel package
 * does in the wire pin (sim-worker-cross-compat.test.ts).
 */

import {
  addBody,
  addDocumentMotor,
  addDocumentSimulation,
  type CadDocument,
  createDocument,
  createDocumentId,
  parseMaterialId,
  serializeCadDocument,
  SIM_CONDITION_KIND_SCENARIOS,
  SIM_DOMAIN_FACES,
  type SimBoundaryCondition,
  SIM_SCENARIO_KINDS,
} from "@slopcad/cad-core";
import { describe, expect, it } from "vitest";

import { SIM_ERROR_CODES } from "./errors";
import { compileSimScenario } from "./units";
import { SIM_CORE_DOMAIN_FACES, SIM_CORE_SCENARIO_KINDS } from "./vocabulary";

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The scenario pin test rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/**
 * One valid exemplar per condition kind — the Record type demands every
 * kind cad-core declares, so a vocabulary addition here fails this suite's
 * type-check until an exemplar (and its compile pin) exists.
 */
const CONDITION_EXEMPLARS: Readonly<
  Record<SimBoundaryCondition["kind"], SimBoundaryCondition>
> = {
  "velocity-inlet": {
    kind: "velocity-inlet",
    face: "xMin",
    speedMPerS: 10,
    direction: [1, 0, 0],
  },
  "pressure-outlet": {
    kind: "pressure-outlet",
    face: "xMax",
    pressurePa: 0,
  },
  wall: { kind: "wall", face: "yMin", slip: true },
  symmetry: { kind: "symmetry", face: "yMax" },
  "fixed-temperature": {
    kind: "fixed-temperature",
    face: "zMin",
    temperatureK: 293.15,
  },
  "heat-flux": { kind: "heat-flux", face: "zMax", fluxWPerM2: 500 },
  "convection-ambient": {
    kind: "convection-ambient",
    face: "xMin",
    heatTransferCoefficientWPerM2K: 10,
    ambientTemperatureK: 293.15,
    emissivity: 0.5,
  },
  "fixed-support": { kind: "fixed-support", face: "xMax" },
  "force-load": { kind: "force-load", face: "yMin", forceN: [0, -100, 0] },
  "pressure-load": {
    kind: "pressure-load",
    face: "yMax",
    pressurePa: 1000,
  },
};

/** A document section in true wire form: plain JSON, never shared objects. */
function wireSection(
  document: CadDocument,
  section: "simulations" | "motors",
): readonly unknown[] {
  const wire = JSON.parse(JSON.stringify(serializeCadDocument(document))) as {
    readonly simulations?: readonly unknown[];
    readonly motors?: readonly unknown[];
  };
  return wire[section] ?? [];
}

describe("the vocabulary pin", () => {
  it("restates cad-core's scenario kinds exactly (same members, same order)", () => {
    expect([...SIM_CORE_SCENARIO_KINDS]).toEqual([...SIM_SCENARIO_KINDS]);
  });

  it("restates cad-core's domain faces exactly (same members, same order)", () => {
    expect([...SIM_CORE_DOMAIN_FACES]).toEqual([...SIM_DOMAIN_FACES]);
  });
});

describe("the condition vocabulary pin", () => {
  const conditionKinds = Object.keys(
    SIM_CONDITION_KIND_SCENARIOS,
  ) as SimBoundaryCondition["kind"][];

  for (const conditionKind of conditionKinds) {
    const allowed = SIM_CONDITION_KIND_SCENARIOS[conditionKind];
    const compilableKind = allowed.find((kind) => kind !== "structural");

    it(`compiles a serialized "${conditionKind}" condition the document stored`, () => {
      const document = requireOk(
        addDocumentSimulation(
          createDocument(createDocumentId("doc_pin_conditions")),
          {
            name: `Pin ${conditionKind}`,
            kind: compilableKind ?? "structural",
            domain: {
              kind: "explicit",
              min: [-100, -100, -100],
              max: [100, 100, 100],
              resolutionMm: 5,
            },
            conditions: [CONDITION_EXEMPLARS[conditionKind]],
            fluid: "air",
            materials: [],
            // Phase 65c: a thermal scenario carries its solve stance
            // (the record boundary kind-locks it), so the thermal-kind
            // exemplars author one.
            ...(compilableKind === "thermal"
              ? {
                  thermal: {
                    radiationMode: "off" as const,
                    solveMode: "steady" as const,
                    cht: false,
                    sourceW: 10,
                    initialTemperatureK: 293.15,
                    ambientConvectionWPerM2K: 5,
                  },
                }
              : {}),
          },
        ),
        "the scenario add",
      ).document;
      const compiled = compileSimScenario({
        scenario: wireSection(document, "simulations")[0],
      });
      if (compilableKind === undefined) {
        // The structural carve: the input is wire-valid cad-core output, so
        // the decline must be the kind gate — never a wire parse failure.
        expect(compiled.ok).toBe(false);
        if (compiled.ok) return;
        expect(compiled.error.code).toBe(
          SIM_ERROR_CODES.scenarioKindUnsupported,
        );
        return;
      }
      expect(compiled.ok).toBe(true);
      if (!compiled.ok) return;
      expect(compiled.value.kind).toBe(compilableKind);
      expect(compiled.value.conditions[0]?.kind).toBe(conditionKind);
      // The backend preference is validated inline at the compile boundary
      // (no restated array): the wire-absent default lands as the CPU oracle.
      expect(compiled.value.backend).toBe("cpu");
    });
  }
});

describe("the serialize → compile round-trip", () => {
  it("compiles a full scenario serialized through the document path", () => {
    const bodyAdded = requireOk(
      addBody(createDocument(createDocumentId("doc_pin_roundtrip")), {
        name: "Fuselage",
      }),
      "the body add",
    );
    const withMotor = requireOk(
      addDocumentMotor(bodyAdded.document, {
        name: "Fan drive",
        kind: "dc-brushed",
        stallTorqueMNm: 100,
        noLoadSpeedRpm: 6000,
        nominalVoltageV: 12,
      }),
      "the motor add",
    );
    const materialId = requireOk(parseMaterialId("mat_alu"), "the material id");
    const withScenario = requireOk(
      addDocumentSimulation(withMotor.document, {
        name: "Wind tunnel pin",
        kind: "flow",
        domain: {
          kind: "explicit",
          min: [-500, -250, -250],
          max: [500, 250, 250],
          resolutionMm: 2,
        },
        conditions: [
          {
            kind: "velocity-inlet",
            face: "xMin",
            speedMPerS: 10,
            direction: [1, 0, 0],
          },
          { kind: "pressure-outlet", face: "xMax", pressurePa: 0 },
        ],
        fluid: "air",
        materials: [{ bodyId: bodyAdded.body.id, materialId }],
        motorId: withMotor.motor.id,
        backend: "gpu",
      }),
      "the scenario add",
    );
    const compiled = compileSimScenario({
      scenario: wireSection(withScenario.document, "simulations")[0],
      motor: wireSection(withScenario.document, "motors")[0],
      bodyBounds: [
        {
          bodyId: bodyAdded.body.id,
          minMm: [-100, -20, -20],
          maxMm: [100, 20, 20],
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.kind).toBe("flow");
    expect(compiled.value.name).toBe("Wind tunnel pin");
    expect(compiled.value.domainMinM).toEqual([-0.5, -0.25, -0.25]);
    expect(compiled.value.domainMaxM).toEqual([0.5, 0.25, 0.25]);
    expect(compiled.value.cellSizeM).toBe(0.002);
    // The one restated preference worth a wire pin: `gpu` survives the
    // boundary the document serialized it for.
    expect(compiled.value.backend).toBe("gpu");
    expect(compiled.value.conditions).toEqual([
      { kind: "velocity-inlet", face: "xMin", velocityMPerS: [10, 0, 0] },
      { kind: "pressure-outlet", face: "xMax", pressurePa: 0 },
    ]);
    if (
      compiled.value.motor === undefined ||
      compiled.value.motor.kind === "tabulated"
    ) {
      throw new Error("The compiled motor must be the analytic line.");
    }
    // The S4 conversions: authored mN·m / rpm become N·m / rad·s⁻¹.
    expect(compiled.value.motor.stallTorqueNPerM).toBe(0.1);
    expect(compiled.value.motor.noLoadSpeedRadPerS).toBe(
      6000 * ((2 * Math.PI) / 60),
    );
    expect(compiled.value.scenarioSnapshotHash).toMatch(/^[0-9a-f]{8}$/);
  });
});
