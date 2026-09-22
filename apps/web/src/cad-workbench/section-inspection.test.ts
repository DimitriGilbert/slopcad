/**
 * The section readout's fixtures (Phase 46): the honesty rules — one
 * resolved body that IS the measured body gets the rows; every other
 * combination (no selection, multi-body, a stale scene body, a declined
 * section with no numbers) shows nothing.
 */

import { describe, expect, it } from "vitest";
import {
  type BodyId,
  createBodyId,
  type FeatureRecord,
} from "@slopcad/cad-core";

import { sectionInspectionReadout } from "./section-inspection";

const body: BodyId = createBodyId("body_section_readout");
const features: readonly FeatureRecord[] = [];
const selected = [{ kind: "body", bodyId: body }] as const;
const centroid = [15, 10, 5] as const;

describe("the section inspection readout", () => {
  it("shows the area and centroid rows for the measured body", () => {
    const readout = sectionInspectionReadout({
      selected,
      features,
      sceneBodyId: body,
      sectionArea: 600,
      sectionCentroid: centroid,
    });
    expect(readout.areaText).toBe("600.000 mm²");
    expect(readout.centroidText).toBe("x 15.000 y 10.000 z 5.000");
  });

  it("shows nothing before a scene settles or a section measures", () => {
    expect(
      sectionInspectionReadout({
        selected,
        features,
        sceneBodyId: undefined,
        sectionArea: 600,
        sectionCentroid: centroid,
      }).areaText,
    ).toBeNull();
    expect(
      sectionInspectionReadout({
        selected,
        features,
        sceneBodyId: body,
        sectionArea: undefined,
        sectionCentroid: undefined,
      }).centroidText,
    ).toBeNull();
  });

  it("shows nothing when the selection resolves to no single body", () => {
    const readout = sectionInspectionReadout({
      selected: [],
      features,
      sceneBodyId: body,
      sectionArea: 600,
      sectionCentroid: centroid,
    });
    expect(readout.areaText).toBeNull();
    expect(readout.centroidText).toBeNull();
  });

  it("shows nothing when the measured body is not the selected body", () => {
    const other = createBodyId("body_other");
    const readout = sectionInspectionReadout({
      selected: [{ kind: "body", bodyId: other }],
      features,
      sceneBodyId: body,
      sectionArea: 600,
      sectionCentroid: centroid,
    });
    expect(readout.areaText).toBeNull();
    expect(readout.centroidText).toBeNull();
  });
});
