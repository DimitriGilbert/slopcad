import { describe, expect, it } from "vitest";

import {
  applyDocumentConfiguration,
  CONFIGURATION_ERROR_CODES,
  type DocumentConfiguration,
  overridesFromCsvRows,
  parseDocumentConfiguration,
  parseParameterTableCsv,
  serializeDocumentConfiguration,
  serializeParameterTableCsv,
} from "./configuration";
import {
  addBody,
  addDocumentConfiguration,
  addDocumentParameter,
  addFeature,
  createDocument,
  parseCadDocument,
  removeBody,
  removeDocumentConfiguration,
  removeDocumentParameter,
  removeFeature,
  serializeCadDocument,
  updateDocumentConfiguration,
} from "./document";
import { length, dimensionless } from "./dimensional";
import {
  createBodyId,
  createConfigurationId,
  createDocumentId,
  createFeatureId,
  createParameterId,
} from "./ids";
import { NATIVE_FORMAT_ERROR_CODES } from "./native-format";
import {
  parseNativeCadDocument,
  serializeNativeCadDocument,
} from "./native-format";

const DOC_ID = createDocumentId("doc_config");

function buildBaseDocument() {
  let document = createDocument(DOC_ID);
  const width = addDocumentParameter(document, {
    id: createParameterId("param_plate_width"),
    name: "plate_width",
    value: length(80),
  });
  if (!width.ok) throw new Error(String(width.error.code));
  document = width.value.document;
  const count = addDocumentParameter(document, {
    id: createParameterId("param_hole_count"),
    name: "hole_count",
    value: dimensionless(2),
  });
  if (!count.ok) throw new Error(String(count.error.code));
  document = count.value.document;
  const body = addBody(document, {
    id: createBodyId("body_plate"),
    name: "plate",
  });
  if (!body.ok) throw new Error(String(body.error.code));
  document = body.value.document;
  // A second body no feature consumes, isolating the configuration in-use
  // guard from the feature guards.
  const spare = addBody(document, {
    id: createBodyId("body_spare"),
    name: "spare",
  });
  if (!spare.ok) throw new Error(String(spare.error.code));
  document = spare.value.document;
  const feature = addFeature(document, {
    id: createFeatureId("feat_extrude-1"),
    kind: "extrude",
    inputs: [{ kind: "parameter", id: createParameterId("param_plate_width") }],
    outputs: [createBodyId("body_plate")],
  });
  if (!feature.ok) throw new Error(String(feature.error.code));
  return {
    document: feature.value.document,
    featureId: feature.value.feature.id,
  };
}

describe("document configurations", () => {
  it("adds a configuration row and round-trips it through serialization", () => {
    const { document } = buildBaseDocument();
    const added = addDocumentConfiguration(document, {
      name: "wide",
      parameterOverrides: [
        {
          parameterId: createParameterId("param_plate_width"),
          value: length(120),
        },
      ],
      suppressedFeatures: [],
      hiddenBodies: [],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const serialized = serializeCadDocument(added.value.document);
    expect(serialized.configurations).toBeDefined();
    const parsed = parseCadDocument(JSON.parse(JSON.stringify(serialized)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.configurations).toHaveLength(1);
    expect(parsed.value.configurations[0]?.name).toBe("wide");
    // A document without configurations serializes without the section.
    const bare = serializeCadDocument(buildBaseDocument().document);
    expect(Object.keys(bare)).not.toContain("configurations");
  });

  it("generates deterministic cfg_ ids and rejects duplicate names and ids", () => {
    const { document } = buildBaseDocument();
    const first = addDocumentConfiguration(document, { name: "small" });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.configuration.id).toBe("cfg_000001");
    const duplicateName = addDocumentConfiguration(first.value.document, {
      name: "small",
    });
    expect(duplicateName.ok).toBe(false);
    if (duplicateName.ok) return;
    expect(duplicateName.error.code).toBe("document/configuration-invalid");
    const duplicateId = addDocumentConfiguration(first.value.document, {
      id: createConfigurationId("cfg_000001"),
      name: "other",
    });
    expect(duplicateId.ok).toBe(false);
    if (duplicateId.ok) return;
    expect(duplicateId.error.code).toBe("document/id-conflict");
  });

  it("refuses rows referencing unknown records or mismatched dimensions", () => {
    const { document } = buildBaseDocument();
    const unknownParameter = addDocumentConfiguration(document, {
      name: "bad",
      parameterOverrides: [
        { parameterId: createParameterId("param_nope"), value: length(1) },
      ],
    });
    expect(unknownParameter.ok).toBe(false);
    if (unknownParameter.ok) return;
    expect(unknownParameter.error.code).toBe(
      "document/configuration-unknown-parameter",
    );
    const dimensionSwap = addDocumentConfiguration(document, {
      name: "bad",
      parameterOverrides: [
        {
          parameterId: createParameterId("param_hole_count"),
          value: length(1),
        },
      ],
    });
    expect(dimensionSwap.ok).toBe(false);
    if (dimensionSwap.ok) return;
    expect(dimensionSwap.error.code).toBe("document/configuration-invalid");
    const unknownFeature = addDocumentConfiguration(document, {
      name: "bad",
      suppressedFeatures: [createFeatureId("feat_ghost")],
    });
    expect(unknownFeature.ok).toBe(false);
    if (unknownFeature.ok) return;
    expect(unknownFeature.error.code).toBe(
      "document/configuration-unknown-feature",
    );
    const unknownBody = addDocumentConfiguration(document, {
      name: "bad",
      hiddenBodies: [createBodyId("body_ghost")],
    });
    expect(unknownBody.ok).toBe(false);
    if (unknownBody.ok) return;
    expect(unknownBody.error.code).toBe("document/configuration-unknown-body");
  });

  it("refuses removing a parameter, feature, or body a configuration references", () => {
    const { document, featureId } = buildBaseDocument();
    const added = addDocumentConfiguration(document, {
      name: "pinned",
      parameterOverrides: [
        {
          parameterId: createParameterId("param_plate_width"),
          value: length(100),
        },
        {
          parameterId: createParameterId("param_hole_count"),
          value: dimensionless(4),
        },
      ],
      suppressedFeatures: [featureId],
      hiddenBodies: [createBodyId("body_spare")],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const configured = added.value.document;
    // The width parameter is feature-referenced, so its removal refuses with
    // the feature guard before the configuration guard; hole_count is free
    // of features and isolates the configuration guard.
    const parameterRemoval = removeDocumentParameter(
      configured,
      createParameterId("param_hole_count"),
    );
    expect(parameterRemoval.ok).toBe(false);
    if (parameterRemoval.ok) return;
    expect(parameterRemoval.error.code).toBe("document/configuration-in-use");
    const featureRemoval = removeFeature(configured, featureId);
    expect(featureRemoval.ok).toBe(false);
    if (featureRemoval.ok) return;
    expect(featureRemoval.error.code).toBe("document/configuration-in-use");
    const bodyRemoval = removeBody(configured, createBodyId("body_spare"));
    expect(bodyRemoval.ok).toBe(false);
    if (bodyRemoval.ok) return;
    expect(bodyRemoval.error.code).toBe("document/configuration-in-use");
    // Removing the row frees every referenced record.
    const droppedRow = removeDocumentConfiguration(
      configured,
      added.value.configuration.id,
    );
    expect(droppedRow.ok).toBe(true);
    if (!droppedRow.ok) return;
    expect(removeFeature(droppedRow.value, featureId).ok).toBe(true);
  });

  it("updates a row in place, keeping its id and position", () => {
    const { document } = buildBaseDocument();
    const first = addDocumentConfiguration(document, { name: "one" });
    const second = addDocumentConfiguration(
      first.ok ? first.value.document : document,
      { name: "two" },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const updated = updateDocumentConfiguration(
      second.value.document,
      second.value.configuration.id,
      { name: "deux", hiddenBodies: [createBodyId("body_plate")] },
    );
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.configurations[1]?.name).toBe("deux");
    expect(updated.value.configurations[0]?.name).toBe("one");
  });

  it("evaluates two configurations into distinct effective views (config-switch fixture)", () => {
    const { document } = buildBaseDocument();
    const small = addDocumentConfiguration(document, {
      name: "small",
      parameterOverrides: [
        {
          parameterId: createParameterId("param_plate_width"),
          value: length(60),
        },
        {
          parameterId: createParameterId("param_hole_count"),
          value: dimensionless(1),
        },
      ],
      suppressedFeatures: [],
    });
    const big = addDocumentConfiguration(
      small.ok ? small.value.document : document,
      {
        name: "big",
        parameterOverrides: [
          {
            parameterId: createParameterId("param_plate_width"),
            value: length(160),
          },
        ],
        suppressedFeatures: [createFeatureId("feat_extrude-1")],
        hiddenBodies: [],
      },
    );
    expect(small.ok && big.ok).toBe(true);
    if (!small.ok || !big.ok) return;
    const rows = big.value.document.configurations;
    const smallView = applyDocumentConfiguration(
      big.value.document,
      rows,
      small.value.configuration.id,
    );
    const bigView = applyDocumentConfiguration(
      big.value.document,
      rows,
      big.value.configuration.id,
    );
    expect(smallView.ok && bigView.ok).toBe(true);
    if (!smallView.ok || !bigView.ok) return;
    const widthOf = (view: typeof smallView.value): number => {
      const parameter = view.parameters.parameters.find(
        (candidate) => candidate.name === "plate_width",
      );
      return parameter?.value.value ?? Number.NaN;
    };
    // Effective parameter values differ per configuration; the base rides
    // through where a row does not override.
    expect(widthOf(smallView.value)).toBe(60);
    expect(widthOf(bigView.value)).toBe(160);
    expect(
      smallView.value.parameters.parameters.find(
        (candidate) => candidate.name === "hole_count",
      )?.value.value,
    ).toBe(1);
    expect(smallView.value.suppressedFeatures).toHaveLength(0);
    expect(bigView.value.suppressedFeatures).toEqual(["feat_extrude-1"]);
  });

  it("refuses evaluating an unknown configuration", () => {
    const { document } = buildBaseDocument();
    const view = applyDocumentConfiguration(
      document,
      document.configurations,
      createConfigurationId("cfg_ghost"),
    );
    expect(view.ok).toBe(false);
    if (view.ok) return;
    expect(view.error.code).toBe(CONFIGURATION_ERROR_CODES.notFound);
  });

  it("round-trips a configuration through its own parse boundary", () => {
    const row: DocumentConfiguration = {
      id: createConfigurationId("cfg_round-trip"),
      name: "round trip",
      parameterOverrides: [
        {
          parameterId: createParameterId("param_plate_width"),
          value: length(42),
        },
      ],
      suppressedFeatures: [createFeatureId("feat_extrude-1")],
      hiddenBodies: [createBodyId("body_plate")],
    };
    const parsed = parseDocumentConfiguration(
      JSON.parse(JSON.stringify(serializeDocumentConfiguration(row))),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(row);
  });
});

describe("the parameter-table CSV", () => {
  it("serializes deterministic bytes with the fixed header and collection order", () => {
    const { document } = buildBaseDocument();
    const first = serializeParameterTableCsv(document);
    const second = serializeParameterTableCsv(document);
    expect(first).toBe(second);
    expect(first).toBe("name,value,unit\nplate_width,80,mm\nhole_count,2,1\n");
  });

  it("parses edited CSV rows back into overrides matching by name", () => {
    const { document } = buildBaseDocument();
    const rows = parseParameterTableCsv(
      "name,value,unit\r\nplate_width,50,mm\r\nhole_count,7,1\r\n",
    );
    expect(rows.ok).toBe(true);
    if (!rows.ok) return;
    const overrides = overridesFromCsvRows(document.parameters, rows.value);
    expect(overrides.ok).toBe(true);
    if (!overrides.ok) return;
    expect(overrides.value).toEqual([
      {
        parameterId: "param_plate_width",
        value: { dimension: "length", unit: "mm", value: 50 },
      },
      {
        parameterId: "param_hole_count",
        value: { dimension: "dimensionless", unit: "1", value: 7 },
      },
    ]);
  });

  it("rejects a BOM, wrong header, unknown parameter, and dimension swap", () => {
    expect(parseParameterTableCsv("﻿name,value,unit\n").ok).toBe(false);
    expect(parseParameterTableCsv("a,b,c\n").ok).toBe(false);
    const { document } = buildBaseDocument();
    const unknown = overridesFromCsvRows(document.parameters, [
      { name: "nope", value: 1, unit: "mm" },
    ]);
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe(CONFIGURATION_ERROR_CODES.notFound);
    const swap = overridesFromCsvRows(document.parameters, [
      { name: "plate_width", value: 1, unit: "deg" },
    ]);
    expect(swap.ok).toBe(false);
    if (swap.ok) return;
    expect(swap.error.code).toBe(CONFIGURATION_ERROR_CODES.overrideInvalid);
  });
});

describe("configurations in the native format", () => {
  it("round-trips a configured document and pins a drawing view to a row", () => {
    const { document } = buildBaseDocument();
    const added = addDocumentConfiguration(document, { name: "pinned" });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const native = serializeNativeCadDocument({
      document: added.value.document,
      history: { base: added.value.document, entries: [], cursor: 0 },
      regeneration: new Map(),
      metadata: {},
      rollback: null,
      drawing: null,
    });
    const parsed = parseNativeCadDocument(native);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.document.configurations).toHaveLength(1);
  });

  it("rejects a drawing view pin naming an unknown configuration", () => {
    const { document } = buildBaseDocument();
    const envelope = serializeNativeCadDocument({
      document,
      history: { base: document, entries: [], cursor: 0 },
      regeneration: new Map(),
      metadata: {},
      rollback: null,
      drawing: null,
    }) as unknown as Record<string, unknown>;
    envelope.drawing = {
      formatVersion: 1,
      sheets: [
        {
          id: "sht_000001",
          size: "A3",
          orientation: "landscape",
          scale: { numerator: 1, denominator: 1 },
          views: [
            {
              id: "dwv_front",
              kind: "front",
              bodyId: "body_plate",
              x: 100,
              y: 100,
              scale: null,
              alignedTo: null,
              configurationId: "cfg_ghost",
            },
          ],
        },
      ],
    };
    const parsed = parseNativeCadDocument(envelope);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(
      NATIVE_FORMAT_ERROR_CODES.configurationUnknownViewPin,
    );
  });
});
