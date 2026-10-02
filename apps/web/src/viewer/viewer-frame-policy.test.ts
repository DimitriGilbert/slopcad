/**
 * The /viewer frame policy: the route's embeddability guarantee is exactly
 * one header — a `frame-ancestors` scheme allow — and nothing else, so the
 * route-scoped rule can never widen into a site-wide relaxation. The allow
 * names SCHEMES, not `*`: the spec's `*` matches only network schemes, and
 * an opaque-origin host page (data:, file:) must embed too — that refusal
 * is exactly what Chromium does with `frame-ancestors *`.
 */

import { describe, expect, it } from "vitest";

import { VIEWER_FRAME_HEADERS } from "./viewer-frame-policy";

describe("viewer frame policy", () => {
  it("declares the frame-ancestors allow, and only that", () => {
    expect(Object.keys(VIEWER_FRAME_HEADERS)).toEqual([
      "content-security-policy",
    ]);
    expect(VIEWER_FRAME_HEADERS["content-security-policy"]).toBe(
      "frame-ancestors http: https: data: blob: file:",
    );
  });

  it("allows opaque-origin embedders (the spec's * would refuse them)", () => {
    const policy = VIEWER_FRAME_HEADERS["content-security-policy"] ?? "";
    for (const scheme of ["http:", "https:", "data:", "blob:", "file:"]) {
      expect(policy).toContain(scheme);
    }
    expect(policy).not.toBe("frame-ancestors *");
  });

  it("carries no credential-touching directive (the share rides the fragment)", () => {
    const policy = VIEWER_FRAME_HEADERS["content-security-policy"] ?? "";
    expect(policy).not.toContain("frame-src");
    expect(policy).not.toContain("connect-src");
  });
});
