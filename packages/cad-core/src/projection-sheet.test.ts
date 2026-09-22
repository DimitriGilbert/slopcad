/**
 * The Phase 48 open-shell projection flag: a sheet body's render object
 * carries `openShell: true` — data, not policy — through the conversion
 * boundary and the wire format, and a closed-solid object never carries
 * it (byte-determinism: pre-flag projections serialize identically).
 */

import { describe, expect, it } from "vitest";

import { createBodyId } from "./ids";
import {
  createRenderProjection,
  parseRenderProjection,
  projectTessellation,
  serializeRenderProjection,
} from "./projection";

const BODY = createBodyId("body_wall");

const TRIANGLE_TESSELLATION = {
  positions: [0, 0, 0, 30, 0, 0, 0, 20, 0],
  indices: [0, 1, 2],
};

const CAMERA = {
  kind: "perspective",
  position: [0, -100, 40],
  target: [0, 0, 0],
  up: [0, 0, 1],
  fovDeg: 45,
} as const;

describe("projection open-shell flag (Phase 48)", () => {
  it("carries openShell through conversion, wire, and parse", () => {
    const object = projectTessellation(
      BODY,
      TRIANGLE_TESSELLATION,
      undefined,
      true,
    );
    if (!object.ok) throw new Error(object.error.message);
    expect(object.value.openShell).toBe(true);
    const projection = createRenderProjection([object.value], CAMERA);
    if (!projection.ok) throw new Error(projection.error.message);
    const serialized = serializeRenderProjection(projection.value);
    const first = serialized.objects[0];
    expect(first?.openShell).toBe(true);
    const parsed = parseRenderProjection(
      JSON.parse(JSON.stringify(serialized)),
    );
    if (!parsed.ok) throw new Error(parsed.error.message);
    expect(parsed.value.objects[0]?.openShell).toBe(true);
  });

  it("omits the flag for closed solids — the wire stays byte-identical", () => {
    const object = projectTessellation(BODY, TRIANGLE_TESSELLATION);
    if (!object.ok) throw new Error(object.error.message);
    expect(object.value.openShell).toBeUndefined();
    const projection = createRenderProjection([object.value], CAMERA);
    if (!projection.ok) throw new Error(projection.error.message);
    const wire = JSON.parse(
      JSON.stringify(serializeRenderProjection(projection.value)),
    ) as { objects: Array<Record<string, unknown>> };
    expect(wire.objects[0]?.openShell).toBeUndefined();
  });
});
