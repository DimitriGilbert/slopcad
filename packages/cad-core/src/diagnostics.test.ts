import { describe, expect, it } from "vitest";

import {
  compareSeverities,
  createDocumentId,
  createFeatureId,
  createParameterId,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SEVERITIES,
  DIAGNOSTIC_SEVERITY_ORDER,
  isDiagnosticCode,
  isDiagnosticSeverity,
  parseDiagnostic,
  type Diagnostic,
  type DiagnosticLocation,
} from "./index";

const baseDiagnostic: Diagnostic = {
  severity: "error",
  code: DIAGNOSTIC_CODES.idWrongPrefix,
  message: 'Expected a feature id but found "param_width".',
  location: {
    primary: createFeatureId("feat_extrude-1"),
    related: [createParameterId("param_width"), createDocumentId("doc_root")],
  },
  data: { expectedPrefix: "feat", attempt: 2, noisy: false, dropped: null },
};

describe("DIAGNOSTIC_SEVERITIES", () => {
  it("pins the four severity levels in increasing severity order", () => {
    expect(DIAGNOSTIC_SEVERITIES).toEqual(["info", "warning", "error", "fatal"]);
  });

  it("orders severities for filtering and sorting", () => {
    expect(compareSeverities("info", "error")).toBeLessThan(0);
    expect(compareSeverities("fatal", "error")).toBeGreaterThan(0);
    expect(compareSeverities("warning", "warning")).toBe(0);
    expect(DIAGNOSTIC_SEVERITY_ORDER.fatal).toBeGreaterThan(
      DIAGNOSTIC_SEVERITY_ORDER.error,
    );
  });

  it("recognizes only the declared severities", () => {
    for (const severity of DIAGNOSTIC_SEVERITIES) {
      expect(isDiagnosticSeverity(severity)).toBe(true);
    }
    for (const invalid of ["critical", "", "ERROR", 3, null, undefined]) {
      expect(isDiagnosticSeverity(invalid)).toBe(false);
    }
  });
});

describe("DIAGNOSTIC_CODES", () => {
  it("contains only unique, stable, domain-prefixed codes", () => {
    const codes = Object.values(DIAGNOSTIC_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(code).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9-]+$/);
    }
  });

  it("recognizes only registered codes", () => {
    for (const code of Object.values(DIAGNOSTIC_CODES)) {
      expect(isDiagnosticCode(code)).toBe(true);
    }
    for (const invalid of ["id", "id/", "nope/x", "", 42, null]) {
      expect(isDiagnosticCode(invalid)).toBe(false);
    }
  });
});

describe("parseDiagnostic", () => {
  it("accepts a fully populated diagnostic and returns it unchanged", () => {
    const result = parseDiagnostic(baseDiagnostic);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(baseDiagnostic);
  });

  it("round-trips diagnostics through JSON", () => {
    const revived = JSON.parse(JSON.stringify(baseDiagnostic)) as unknown;
    const result = parseDiagnostic(revived);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(baseDiagnostic);
  });

  it("accepts every declared severity", () => {
    for (const severity of DIAGNOSTIC_SEVERITIES) {
      const result = parseDiagnostic({ ...baseDiagnostic, severity });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.severity).toBe(severity);
    }
  });

  it("allows omitting related ids and structured data", () => {
    const minimal: Diagnostic = {
      severity: "warning",
      code: DIAGNOSTIC_CODES.idEmpty,
      message: "An id was empty.",
      location: { primary: createDocumentId("doc_root") },
    };
    const result = parseDiagnostic(minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(minimal);
  });

  it("rejects non-object input with diagnostic/malformed", () => {
    for (const input of [null, "error", 42, [baseDiagnostic]]) {
      const result = parseDiagnostic(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("diagnostic/malformed");
        expect(result.error.input).toBe(input);
      }
    }
  });

  it("rejects invalid severity values", () => {
    expect(parseDiagnostic({ ...baseDiagnostic, severity: "critical" }).ok).toBe(false);
    expect(parseDiagnostic({ ...baseDiagnostic, severity: 7 }).ok).toBe(false);
  });

  it("rejects unregistered codes", () => {
    expect(parseDiagnostic({ ...baseDiagnostic, code: "kernel/crash" }).ok).toBe(false);
  });

  it("rejects empty or non-string messages", () => {
    expect(parseDiagnostic({ ...baseDiagnostic, message: "" }).ok).toBe(false);
    expect(parseDiagnostic({ ...baseDiagnostic, message: 5 }).ok).toBe(false);
    expect(parseDiagnostic({ ...baseDiagnostic, message: undefined }).ok).toBe(false);
  });

  it("rejects diagnostics without a valid location primary id", () => {
    expect(
      parseDiagnostic({
        severity: baseDiagnostic.severity,
        code: baseDiagnostic.code,
        message: baseDiagnostic.message,
      }).ok,
    ).toBe(false);
    expect(parseDiagnostic({
      ...baseDiagnostic,
      location: { primary: "not-an-id" },
    }).ok).toBe(false);
  });

  it("rejects malformed related id lists", () => {
    expect(
      parseDiagnostic({
        ...baseDiagnostic,
        location: { ...baseDiagnostic.location, related: "param_width" },
      }).ok,
    ).toBe(false);
    expect(
      parseDiagnostic({
        ...baseDiagnostic,
        location: { ...baseDiagnostic.location, related: ["param_width", "junk"] },
      }).ok,
    ).toBe(false);
  });

  it("rejects non-primitive or non-finite data values", () => {
    expect(
      parseDiagnostic({ ...baseDiagnostic, data: { nested: { deep: 1 } } }).ok,
    ).toBe(false);
    expect(parseDiagnostic({ ...baseDiagnostic, data: { list: [1] } }).ok).toBe(false);
    expect(
      parseDiagnostic({ ...baseDiagnostic, data: { nan: Number.NaN } }).ok,
    ).toBe(false);
    expect(parseDiagnostic({ ...baseDiagnostic, data: "nope" }).ok).toBe(false);
  });

  it("anchors locations to branded domain ids at the type level", () => {
    const valid: DiagnosticLocation = { primary: createDocumentId("doc_root") };
    // @ts-expect-error a plain string must not be usable as a location primary
    const invalid: DiagnosticLocation = { primary: "doc_root" };
    expect(valid.primary).toBe("doc_root");
    expect(invalid.primary).toBe("doc_root");
  });
});
