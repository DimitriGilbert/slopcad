/**
 * DXF import golden fixtures (Phase 56): hand-authored ASCII DXF samples →
 * expected cad-sketch entities, exact where decimal text is exact and
 * within a documented 1e-9 band where trigonometry (bulge arcs, degrees→
 * radians) rounds. The decline discipline is tested alongside: scope
 * boundaries record, defects reject.
 */

import { describe, expect, test } from "vitest";
import type { ArcEntity, LineEntity, SplineEntity } from "@slopcad/cad-sketch";

import { DXF_UNIT_TO_MILLIMETER_FACTORS, importDxf } from "./dxf-import";

const encoder = new TextEncoder();

const dxf = (entities: string, header = ""): Uint8Array =>
  encoder.encode(
    `0\nSECTION\n2\nHEADER\n${header}0\nENDSEC\n0\nSECTION\n2\nENTITIES\n${entities}\n0\nENDSEC\n0\nEOF\n`,
  );

describe("DXF import — golden fixtures", () => {
  test("imports a line, a circle, and an arc into the pinned vocabulary", () => {
    const result = importDxf(
      dxf(
        [
          "0\nLINE\n5\n2AF\n8\noutline\n10\n0\n20\n0\n11\n30\n21\n40",
          "0\nCIRCLE\n5\n2B0\n8\noutline\n10\n15\n20\n20\n40\n5",
          "0\nARC\n5\n2B1\n8\noutline\n10\n15\n20\n20\n40\n5\n50\n0\n51\n90",
        ].join("\n"),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(3);
    expect(result.value.units).toBe("mm");
    expect(result.value.unitsSource).toBe("default-mm");
    expect(result.value.layers).toEqual(["outline"]);
    expect(result.value.declined).toEqual([]);

    const line = result.value.entities[0] as LineEntity;
    expect(line.kind).toBe("line");
    expect(line.x1).toBe(0);
    expect(line.y1).toBe(0);
    expect(line.x2).toBe(30);
    expect(line.y2).toBe(40);
    expect(line.id).toBe("skent_2af");

    const circle = result.value.entities[1];
    expect(circle).toMatchObject({
      kind: "circle",
      cx: 15,
      cy: 20,
      radius: 5,
      id: "skent_2b0",
    });

    const arc = result.value.entities[2] as ArcEntity;
    expect(arc.kind).toBe("arc");
    expect(arc.cx).toBe(15);
    expect(arc.cy).toBe(20);
    expect(arc.radius).toBe(5);
    expect(arc.startAngle).toBe(0);
    expect(arc.endAngle).toBeCloseTo(Math.PI / 2, 9);
  });

  test("scales through $INSUNITS (inches) and records the provenance", () => {
    const result = importDxf(
      dxf(
        "0\nLINE\n5\n10\n10\n0\n20\n0\n11\n1\n21\n0",
        "9\n$INSUNITS\n70\n1\n",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unitsSource).toBe("insunits");
    expect(result.value.unitName).toBe("inches");
    expect(result.value.units).toBe("mm");
    const line = result.value.entities[0] as LineEntity | undefined;
    expect(line?.x2).toBeCloseTo(DXF_UNIT_TO_MILLIMETER_FACTORS.inches, 9);
  });

  test("declines an out-of-table unit instead of guessing a scale", () => {
    const result = importDxf(
      dxf(
        "0\nLINE\n5\n10\n10\n0\n20\n0\n11\n1\n21\n0",
        "9\n$INSUNITS\n70\n99\n",
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("dxf-import/unsupported-unit");
  });

  test("converts LWPOLYLINE with a bulge to lines plus an exact arc", () => {
    // A closed right-angle square whose top edge carries a bulge of 1
    // (a semicircle: θ = 4·atan(1) = π).
    const result = importDxf(
      dxf(
        "0\nLWPOLYLINE\n5\n30\n90\n4\n70\n1\n10\n0\n20\n0\n10\n40\n20\n0\n10\n40\n20\n30\n42\n1\n10\n0\n20\n30",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 3 straight segments + 1 semicircular arc (the closing segment's
    // bulge rides the last vertex).
    expect(result.value.entities).toHaveLength(4);
    const kinds = result.value.entities.map((entity) => entity.kind);
    expect(kinds).toContain("arc");
    const arc = result.value.entities.find(
      (entity): entity is ArcEntity => entity.kind === "arc",
    );
    // The semicircle over the chord (40,30)→(0,30): radius 20, center (20,30).
    expect(arc?.radius).toBe(20);
    expect(arc?.cx).toBeCloseTo(20, 9);
    expect(arc?.cy).toBeCloseTo(30, 9);
  });

  test("imports an exact cubic Bézier-chain SPLINE into the control flavor", () => {
    const result = importDxf(
      dxf(
        "0\nSPLINE\n5\n40\n70\n8\n71\n3\n72\n8\n73\n4\n74\n0\n40\n0\n40\n0\n40\n0\n40\n0\n40\n1\n40\n1\n40\n1\n40\n1\n10\n0\n20\n0\n10\n10\n20\n0\n10\n10\n20\n10\n10\n0\n20\n10",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(1);
    const spline = result.value.entities[0] as SplineEntity;
    expect(spline.kind).toBe("spline");
    expect(spline.flavor).toBe("control");
    expect(spline.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  test("declines a fit-point spline instead of fabricating a curve through it", () => {
    const result = importDxf(
      dxf(
        "0\nSPLINE\n5\n41\n71\n3\n73\n4\n74\n3\n10\n0\n20\n0\n10\n10\n20\n0\n10\n10\n20\n10\n10\n0\n20\n10\n11\n5\n21\n5",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(0);
    expect(result.value.declined).toEqual([
      {
        kind: "SPLINE",
        handle: "41",
        layer: null,
        reason: "spline-out-of-subset",
      },
    ]);
  });

  test("filters to requested layers and reports the imported layers", () => {
    const entities =
      "0\nLINE\n5\n50\n8\nCUT\n10\n0\n20\n0\n11\n1\n21\n0\n" +
      "0\nLINE\n5\n51\n8\nDim\n10\n0\n20\n0\n11\n2\n21\n0";
    const all = importDxf(dxf(entities));
    expect(all.ok && all.value.layers).toEqual(["CUT", "Dim"]);
    const onlyDim = importDxf(dxf(entities), { layers: ["dim"] });
    expect(
      onlyDim.ok && onlyDim.ok === true && onlyDim.value.entities,
    ).toHaveLength(1);
    const dim = onlyDim.ok
      ? (onlyDim.value.entities[0] as LineEntity)
      : undefined;
    expect(dim?.x2).toBe(2);
    expect(onlyDim.ok && onlyDim.value.layers).toEqual(["Dim"]);
  });

  test("records out-of-subset kinds, then imports the rest", () => {
    const result = importDxf(
      dxf(
        "0\nINSERT\n5\n60\n8\nBlocks\n2\nScrew\n10\n0\n20\n0\n" +
          "0\nLINE\n5\n61\n10\n0\n20\n0\n11\n5\n21\n5",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities).toHaveLength(1);
    expect(result.value.declined).toEqual([
      {
        kind: "INSERT",
        handle: "60",
        layer: "Blocks",
        reason: "kind-out-of-subset",
      },
    ]);
  });

  test("rejects an in-subset defect (zero radius) for the whole file", () => {
    const result = importDxf(
      dxf(
        "0\nLINE\n5\n70\n10\n0\n20\n0\n11\n5\n21\n5\n" +
          "0\nCIRCLE\n5\n71\n10\n0\n20\n0\n40\n0",
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("dxf-import/entity-invalid");
    expect(result.error.message).toContain("handle 71");
  });

  test("rejects duplicate handles — ids mint from handles", () => {
    const result = importDxf(
      dxf(
        "0\nLINE\n5\n80\n10\n0\n20\n0\n11\n1\n21\n0\n" +
          "0\nLINE\n5\n80\n10\n0\n20\n0\n11\n2\n21\n0",
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("dxf-import/duplicate-handle");
  });

  test("mints deterministic keys for handleless R12 records", () => {
    const result = importDxf(
      dxf(
        "0\nLINE\n10\n0\n20\n0\n11\n1\n21\n0\n" +
          "0\nLINE\n10\n0\n20\n0\n11\n2\n21\n0",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.entities.map((entity) => entity.id)).toEqual([
      "skent_dxf0",
      "skent_dxf1",
    ]);
  });

  test("rejects empty, binary, and non-DXF input", () => {
    const empty = importDxf(new Uint8Array());
    expect(!empty.ok && empty.error.code).toBe("dxf-import/empty");

    const binary = importDxf(
      encoder.encode("AutoCAD Binary DXF\r\n\x1a\x00binary-ish"),
    );
    expect(!binary.ok && binary.error.code).toBe(
      "dxf-import/binary-unsupported",
    );

    const text = importDxf(encoder.encode("not a dxf at all\njust words\n"));
    expect(!text.ok && text.error.code).toBe("dxf-import/not-dxf");
  });
});
