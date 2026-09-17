import { describe, expect, it } from "vitest";

import {
  SKETCH_DIAGNOSTIC_CODES,
  isSketchDiagnosticCode,
  parseSketchDiagnostic,
  sketchDiagnostic,
} from "./diagnostics";
import { createSketchConstraintId, createSketchEntityId } from "./sketch-ids";

describe("sketch diagnostics", () => {
  it("registers the full sketch/* code set with stable names", () => {
    expect(SKETCH_DIAGNOSTIC_CODES.idWrongPrefix).toBe("sketch/id-wrong-prefix");
    expect(SKETCH_DIAGNOSTIC_CODES.versionUnsupported).toBe(
      "sketch/version-unsupported",
    );
    expect(SKETCH_DIAGNOSTIC_CODES.workplaneDegenerate).toBe(
      "sketch/workplane-degenerate",
    );
    expect(SKETCH_DIAGNOSTIC_CODES.entityDuplicateId).toBe(
      "sketch/entity-duplicate-id",
    );
    expect(SKETCH_DIAGNOSTIC_CODES.constraintReferenceMalformed).toBe(
      "sketch/constraint-reference-malformed",
    );
    expect(SKETCH_DIAGNOSTIC_CODES.underConstrained).toBe("sketch/under-constrained");
    expect(SKETCH_DIAGNOSTIC_CODES.constraintsRedundant).toBe(
      "sketch/constraints-redundant",
    );
    expect(SKETCH_DIAGNOSTIC_CODES.constraintsConflicting).toBe(
      "sketch/constraints-conflicting",
    );
    expect(SKETCH_DIAGNOSTIC_CODES.constraintsUnsatisfiable).toBe(
      "sketch/constraints-unsatisfiable",
    );
    expect(SKETCH_DIAGNOSTIC_CODES.solverNotConverged).toBe(
      "sketch/solver-not-converged",
    );
    expect(isSketchDiagnosticCode("sketch/under-constrained")).toBe(true);
    expect(isSketchDiagnosticCode("id/wrong-prefix")).toBe(false);
    expect(isSketchDiagnosticCode(7)).toBe(false);
  });

  it("round-trips a diagnostic through JSON", () => {
    const diagnostic = sketchDiagnostic(
      "warning",
      SKETCH_DIAGNOSTIC_CODES.constraintsRedundant,
      "One constraint is redundant.",
      {
        primary: createSketchConstraintId("skcon_000001"),
        related: [
          createSketchConstraintId("skcon_000002"),
          createSketchEntityId("skent_000003"),
        ],
      },
      { redundantEquations: 1 },
    );
    const parsed = parseSketchDiagnostic(JSON.parse(JSON.stringify(diagnostic)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual(diagnostic);
    expect(parseSketchDiagnostic(parsed.value).ok).toBe(true);
  });

  it("rejects malformed diagnostics with structured failures", () => {
    expect(!parseSketchDiagnostic(null).ok).toBe(true);
    expect(
      !parseSketchDiagnostic({
        severity: "fatal",
        code: "sketch/under-constrained",
        message: "x",
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchDiagnostic({
        severity: "error",
        code: "not/a-sketch-code",
        message: "x",
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchDiagnostic({ severity: "error", code: "sketch/malformed", message: "" })
        .ok,
    ).toBe(true);
    expect(
      !parseSketchDiagnostic({
        severity: "error",
        code: "sketch/malformed",
        message: "x",
        location: { primary: "not-an-id" },
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchDiagnostic({
        severity: "error",
        code: "sketch/malformed",
        message: "x",
        data: { bad: { nested: true } },
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchDiagnostic({
        severity: "error",
        code: "sketch/malformed",
        message: "x",
        data: { bad: Number.NaN },
      }).ok,
    ).toBe(true);
  });
});
