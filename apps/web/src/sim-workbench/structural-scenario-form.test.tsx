/**
 * The structural-scenario form's tests (Phase 69, the thermal form's
 * test precedent): the Formedible CONFIG OBJECT is the product — every
 * schema key has its field, every option list is the phase's
 * vocabulary, the defaults are the demo bracket, and the mapper turns
 * submitted values into a cad-core scenario draft the document accepts
 * (with the kind-locked structural stance). The component half: the
 * form renders every field from the config and submitting delivers the
 * mapped draft through the surface the page wires.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDocumentSimulation,
  serializeSimScenario,
  type SimScenarioDraft,
} from "@slopcad/cad-core";

import { bracketDemoDocument } from "./bracket-demo";
import {
  STRUCTURAL_FORM_DEFAULT_VALUES,
  StructuralScenarioForm,
  structuralScenarioDraftOf,
  structuralScenarioFields,
  structuralScenarioSchema,
} from "./structural-scenario-form";

/**
 * The demo document the page voxelizes — its two bracket bodies are the
 * bodies the material assignments address.
 */
const DEMO_DOCUMENT = bracketDemoDocument();
const BODY_IDS = DEMO_DOCUMENT.bodies.map((body) => body.id);

afterEach(cleanup);

describe("the structural-scenario form config", () => {
  it("gives every schema key exactly one field, with the phase vocabularies", () => {
    const schemaKeys = Object.keys(
      structuralScenarioSchema.shape,
    ) as readonly (keyof typeof STRUCTURAL_FORM_DEFAULT_VALUES)[];
    const fieldNames = structuralScenarioFields.map((field) => field.name);
    expect(new Set(fieldNames).size).toBe(fieldNames.length);
    expect([...fieldNames].sort()).toEqual([...schemaKeys].sort());
    const optionValuesOf = (
      name: keyof typeof STRUCTURAL_FORM_DEFAULT_VALUES,
    ): readonly string[] => {
      const field = structuralScenarioFields.find(
        (entry) => entry.name === name,
      );
      const options = field?.options;
      if (typeof options !== "object" || options === null) return [];
      return options.map((option) =>
        typeof option === "string" ? option : option.value,
      );
    };
    expect(optionValuesOf("fixtureKind")).toEqual([
      "fixed-face",
      "symmetry-roller",
      "point-fix",
    ]);
    expect(optionValuesOf("loadKind")).toEqual([
      "force-point",
      "force-face",
      "pressure-face",
    ]);
    expect(optionValuesOf("centrifugalMode")).toEqual([
      "none",
      "fixed",
      "fan-run",
    ]);
    expect(optionValuesOf("fixtureFace")).toContain("zMin");
  });

  it("maps the defaults onto the demo draft the document accepts", () => {
    const draft = structuralScenarioDraftOf(
      STRUCTURAL_FORM_DEFAULT_VALUES,
      BODY_IDS,
    );
    expect(draft.kind).toBe("structural");
    expect(draft.conditions).toEqual([
      { kind: "fixed-support", face: "zMin" },
      {
        kind: "point-load",
        atWorldPointMm: [0, -36, 80],
        forceN: [0, -500, 0],
      },
    ]);
    expect(draft.structural).toEqual({ selfWeight: false });
    expect(draft.materials).toHaveLength(2);
    const added = addDocumentSimulation(DEMO_DOCUMENT, draft);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    // The serialized record (what crosses to compile) is canonical and
    // snapshot-stable: serializing twice yields identical bytes.
    const first = JSON.stringify(serializeSimScenario(added.value.scenario));
    const second = JSON.stringify(serializeSimScenario(added.value.scenario));
    expect(second).toBe(first);
  });

  it("maps every fixture/load branch and the body-force stances", () => {
    const rollerDraft = structuralScenarioDraftOf(
      {
        ...STRUCTURAL_FORM_DEFAULT_VALUES,
        fixtureKind: "symmetry-roller",
        rollerAxis: "y",
        fixtureFace: "yMax",
        loadKind: "force-face",
        loadFace: "yMax",
      },
      BODY_IDS,
    );
    expect(rollerDraft.conditions).toEqual([
      { kind: "axis-fix", face: "yMax", axis: "y" },
      {
        kind: "force-load",
        face: "yMax",
        forceN: [0, -500, 0],
      },
    ]);

    const pressureDraft = structuralScenarioDraftOf(
      {
        ...STRUCTURAL_FORM_DEFAULT_VALUES,
        fixtureKind: "point-fix",
        fixturePointX: 10,
        fixturePointY: 0,
        fixturePointZ: 0,
        loadKind: "pressure-face",
        loadFace: "zMax",
        loadPressurePa: 250000,
      },
      BODY_IDS,
    );
    expect(pressureDraft.conditions).toEqual([
      { kind: "point-fix", atWorldPointMm: [10, 0, 0] },
      { kind: "pressure-load", face: "zMax", pressurePa: 250000 },
    ]);

    const loadedDraft = structuralScenarioDraftOf(
      {
        ...STRUCTURAL_FORM_DEFAULT_VALUES,
        selfWeight: true,
        centrifugalMode: "fixed",
        centrifugalFixedRpm: 3000,
        thermalChain: true,
        referenceTemperatureK: 293.15,
      },
      BODY_IDS,
    );
    expect(loadedDraft.structural).toEqual({
      selfWeight: true,
      centrifugal: {
        axisPointMm: [0, 0, 0],
        axisDirection: [0, 0, 1],
        rpmMode: "fixed",
        fixedRpm: 3000,
      },
      thermal: { referenceTemperatureK: 293.15 },
    });

    const fanRunDraft = structuralScenarioDraftOf(
      {
        ...STRUCTURAL_FORM_DEFAULT_VALUES,
        centrifugalMode: "fan-run",
        centrifugalAxisDirX: 0,
        centrifugalAxisDirY: 1,
        centrifugalAxisDirZ: 0,
      },
      BODY_IDS,
    );
    expect(fanRunDraft.structural?.centrifugal?.rpmMode).toBe("fan-run");
    expect(fanRunDraft.structural?.centrifugal?.fixedRpm).toBeUndefined();
  });
});

describe("the StructuralScenarioForm component", () => {
  it("renders from the config and submits the mapped draft", async () => {
    const submitted: SimScenarioDraft[] = [];
    const onSubmit = vi.fn((draft: SimScenarioDraft) => {
      submitted.push(draft);
    });
    render(
      <StructuralScenarioForm bodyIds={BODY_IDS} onSubmitScenario={onSubmit} />,
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/scenario name/i)).toBeDefined();
    });
    const submit = screen.getByRole("button", {
      name: "Save structural scenario",
    });
    await waitFor(() => {
      expect((submit as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(submit);
    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    expect(submitted[0]?.kind).toBe("structural");
    expect(submitted[0]?.structural).toEqual({ selfWeight: false });
  });
});
