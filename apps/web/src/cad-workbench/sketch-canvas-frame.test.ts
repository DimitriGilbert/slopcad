import { describe, expect, it } from "vitest";

import { sketchCanvasSize } from "./sketch-canvas-frame";

const FALLBACK = { height: 520, width: 800 } as const;

describe("sketchCanvasSize", () => {
  it("keeps the documented constants until a measurement exists", () => {
    expect(sketchCanvasSize(null, FALLBACK)).toEqual(FALLBACK);
  });

  it("keeps them for a zero-sized box (no layout: jsdom, first frame)", () => {
    expect(sketchCanvasSize({ height: 0, width: 0 }, FALLBACK)).toEqual(
      FALLBACK,
    );
    expect(sketchCanvasSize({ height: 400, width: 0 }, FALLBACK)).toEqual(
      FALLBACK,
    );
  });

  it("fills the measured frame, floored to whole pixels", () => {
    expect(
      sketchCanvasSize({ height: 612.4, width: 1040.8 }, FALLBACK),
    ).toEqual({ height: 612, width: 1040 });
  });
});
