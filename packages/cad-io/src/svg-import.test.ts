/**
 * SVG import golden fixtures (Phase 56): hand-authored ASCII SVG samples →
 * expected cad-sketch entities, exact where decimal text is exact and
 * within a documented 1e-9 band where trigonometry (arc center
 * parameterization, quadratic elevation) rounds. Decline and failure
 * discipline tested alongside: scope boundaries record, defects reject.
 */

import { describe, expect, test } from "vitest";
import type {
  ArcEntity,
  CircleEntity,
  LineEntity,
  SplineEntity,
} from "@slopcad/cad-sketch";

import { importSvg } from "./svg-import";

const encoder = new TextEncoder();

const svg = (body: string, viewBox = "0 0 100 100"): Uint8Array =>
  encoder.encode(
    `<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">\n${body}\n</svg>\n`,
  );

describe("SVG import — golden fixtures", () => {
  test("imports line, circle, and rect elements into the pinned vocabulary", () => {
    const result = importSvg(
      svg(
        `<line x1="10" y1="20" x2="30" y2="40"/>\n` +
          `<circle cx="50" cy="25" r="7"/>\n` +
          `<rect x="0" y="0" width="10" height="4"/>`,
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(6); // 1 line + 1 circle + 4 rect edges
    expect(result.value.units).toBe("mm");
    expect(result.value.viewBox).toEqual({ x: 0, y: 0 });
    expect(result.value.declined).toEqual([]);

    // SVG y-down mirrors to the sketch plane: y' = -(y - viewBox.y).
    const line = result.value.entities[0] as LineEntity;
    expect(line.kind).toBe("line");
    expect(line.x1).toBe(10);
    expect(line.y1).toBe(-20);
    expect(line.x2).toBe(30);
    expect(line.y2).toBe(-40);

    const circle = result.value.entities[1] as CircleEntity;
    expect(circle.kind).toBe("circle");
    expect(circle.cx).toBe(50);
    expect(circle.cy).toBe(-25);
    expect(circle.radius).toBe(7);

    const rectEdges = result.value.entities.slice(2) as LineEntity[];
    expect(rectEdges.map((edge) => edge.id)).toEqual([
      "skent_svg2",
      "skent_svg2-s1",
      "skent_svg2-s2",
      "skent_svg2-s3",
    ]);
    expect(rectEdges[0]).toMatchObject({ x1: 0, y1: 0, x2: 10, y2: 0 });
    expect(rectEdges[2]).toMatchObject({ x1: 10, y1: -4, x2: 0, y2: -4 });
  });

  test("applies the viewBox origin as a translation", () => {
    const result = importSvg(
      svg(`<line x1="15" y1="15" x2="20" y2="20"/>`, "5 10 100 100"),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = result.value.entities[0] as LineEntity;
    expect(line.x1).toBe(10); // 15 - viewBox.x
    expect(line.y1).toBeCloseTo(-5, 9); // -(15 - 10)
    expect(result.value.viewBox).toEqual({ x: 5, y: 10 });
  });

  test("converts an M/L/Z path with implicit repetition exactly", () => {
    const result = importSvg(svg(`<path d="M 0 0 10 0 L 10 10 0 10 Z"/>`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // M(0,0) → implicit L(10,0) → L(10,10) → implicit L(0,10) → Z closes.
    expect(result.value.entities).toHaveLength(4);
    const kinds = result.value.entities.map((entity) => entity.kind);
    expect(new Set(kinds)).toEqual(new Set(["line"]));
    const last = result.value.entities[3] as LineEntity;
    expect(last).toMatchObject({ x1: 0, y1: -10, x2: 0, y2: 0 });
  });

  test("imports a cubic C path as an exact control-flavor spline", () => {
    const result = importSvg(svg(`<path d="M 0 0 C 10 0 20 10 30 10"/>`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(1);
    const spline = result.value.entities[0] as SplineEntity;
    expect(spline.kind).toBe("spline");
    expect(spline.flavor).toBe("control");
    expect(spline.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: -10 },
      { x: 30, y: -10 },
    ]);
  });

  test("elevates a quadratic Q exactly to a cubic spline", () => {
    const result = importSvg(svg(`<path d="M 0 0 Q 5 5 10 0"/>`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const spline = result.value.entities[0] as SplineEntity;
    // Exact elevation: c1 = (p0 + 2·p1)/3, c2 = (2·p1 + p2)/3.
    expect(spline.points[1]).toEqual({ x: 10 / 3, y: -10 / 3 });
    expect(spline.points[2]).toEqual({ x: 20 / 3, y: -10 / 3 });
  });

  test("converts an unrotated circular A arc through the exact center form", () => {
    // Semicircle from (0,0) to (20,0), radius 10, sweep=1 (y-down CW →
    // sketch CCW through (10,-10)... the mirrored center sits at (10, 0),
    // the drawn apex at (10, ±10) mirrored to ∓10).
    const result = importSvg(svg(`<path d="M 0 0 A 10 10 0 0 1 20 0"/>`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(1);
    const arc = result.value.entities[0] as ArcEntity;
    expect(arc.kind).toBe("arc");
    expect(arc.cx).toBeCloseTo(10, 9);
    expect(arc.cy).toBeCloseTo(0, 9);
    expect(arc.radius).toBeCloseTo(10, 9);
    // Mirrored sweep: start angle at (0,0) is π; the arc passes through
    // the mirrored apex (10, -10) at 3π/2 → CCW from π to 0.
    expect(arc.startAngle).toBeCloseTo(Math.PI, 9);
    expect(arc.endAngle).toBeCloseTo(0, 9);
  });

  test("declines out-of-subset commands and elements without dropping the rest", () => {
    const result = importSvg(
      svg(
        `<path d="M 0 0 S 5 5 10 0"/>\n` +
          `<text x="0" y="0">hi</text>\n` +
          `<line x1="0" y1="0" x2="1" y2="1"/>\n` +
          `<ellipse cx="0" cy="0" rx="5" ry="9"/>`,
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(1); // the line only
    expect(result.value.declined).toEqual([
      { kind: "path", reason: "command-out-of-subset" },
      { kind: "text", reason: "element-out-of-subset" },
      { kind: "ellipse", reason: "element-out-of-subset" },
    ]);
  });

  test("declines transformed elements and elliptical or rotated arcs", () => {
    const result = importSvg(
      svg(
        `<g transform="translate(5 5)"><rect x="0" y="0" width="2" height="2"/></g>\n` +
          `<path d="M 0 0 A 10 5 0 0 1 20 0"/>\n` +
          `<path d="M 0 0 A 10 10 45 0 1 20 0"/>`,
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(0);
    expect(result.value.declined).toEqual([
      // The transformed container declines, and so does everything inside
      // it — its coordinates would land in the wrong place untransformed.
      { kind: "g", reason: "transform-out-of-subset" },
      { kind: "rect", reason: "transform-out-of-subset" },
      { kind: "path", reason: "arc-out-of-subset" },
      { kind: "path", reason: "arc-out-of-subset" },
    ]);
  });

  test("treats a same-radii ellipse as an exact circle", () => {
    const result = importSvg(svg(`<ellipse cx="10" cy="10" rx="4" ry="4"/>`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(1);
    expect(result.value.entities[0]).toMatchObject({
      kind: "circle",
      cx: 10,
      cy: -10,
      radius: 4,
    });
  });

  test("rejects empty, binary, non-SVG, malformed-viewBox, and non-finite input", () => {
    expect(!importSvg(new Uint8Array()).ok).toBe(true);
    const binary = importSvg(encoder.encode("<svg>\n\x00\x01\n</svg>"));
    expect(!binary.ok && binary.error.code).toBe(
      "svg-import/binary-unsupported",
    );
    const notSvg = importSvg(encoder.encode("<html><body>nope</body></html>"));
    expect(!notSvg.ok && notSvg.error.code).toBe("svg-import/not-svg");
    const badViewBox = importSvg(
      encoder.encode(
        '<svg viewBox="0 0 NaN 100"><line x1="0" y1="0" x2="1" y2="1"/></svg>',
      ),
    );
    expect(!badViewBox.ok && badViewBox.error.code).toBe(
      "svg-import/invalid-viewbox",
    );
    const badNumber = importSvg(svg(`<line x1="oops" y1="0" x2="1" y2="1"/>`));
    expect(!badNumber.ok && badNumber.error.code).toBe(
      "svg-import/invalid-number",
    );
    const zeroRadius = importSvg(svg(`<circle cx="0" cy="0" r="0"/>`));
    expect(!zeroRadius.ok && zeroRadius.error.code).toBe(
      "svg-import/invalid-number",
    );
    const pathGarbage = importSvg(svg(`<path d="M 0 0 L oops"/>`));
    expect(!pathGarbage.ok && pathGarbage.error.code).toBe(
      "svg-import/invalid-number",
    );
  });
});
