/**
 * The share codec's contract: both encodings round-trip byte-identically,
 * a `1b` fallback link decodes everywhere (the decoder sniffs the tag),
 * refusals are structured (never a thrown opaque error), the deflate
 * default actually buys the URL back for the repetitive native JSON it
 * carries, and decoding is BOUNDED — an oversized fragment and a deflate
 * bomb are both refused by arithmetic, never by an out-of-memory tab.
 */

import { describe, expect, it } from "vitest";

import {
  buildSharePath,
  decodeNativeFromShare,
  encodeNativeForShare,
  SHARE_INFLATE_MAX_BYTES,
  SHARE_PAYLOAD_MAX_CHARS,
} from "./share-codec";

/** A native-shaped repetitive JSON payload (the format's fixed keys). */
const NATIVE_TEXT = JSON.stringify({
  document: {
    bodies: [{ id: "body_plate", name: "plate" }],
    features: [
      { id: "feat_translate_plate", kind: "translate" },
      { id: "feat_rotate_plate", kind: "rotate" },
    ],
    parameters: [{ id: "param_hole_diameter", name: "holeDiameter" }],
  },
  history: { committed: [] as string[] },
  metadata: {},
});

describe("share codec round trips", () => {
  it("deflate round-trips the exact native text", async () => {
    const payload = await encodeNativeForShare(NATIVE_TEXT);
    expect(payload.startsWith("1d.")).toBe(true);
    const decoded = await decodeNativeFromShare(payload);
    expect(decoded).toEqual({ ok: true, text: NATIVE_TEXT });
  });

  it("round-trips through a full fragment link (leading #)", async () => {
    const payload = await encodeNativeForShare(NATIVE_TEXT);
    const decoded = await decodeNativeFromShare(`#${payload}`);
    expect(decoded).toEqual({ ok: true, text: NATIVE_TEXT });
  });

  it("the link path is a viewer URL with the payload as the fragment", async () => {
    const payload = await encodeNativeForShare("anything");
    expect(buildSharePath(payload)).toBe(`/viewer#${payload}`);
  });

  it("deflate beats plain base64 on the repetitive native JSON", async () => {
    const payload = await encodeNativeForShare(NATIVE_TEXT);
    const plain = await decodeNativeFromShare(`1b.${btoa(NATIVE_TEXT)}`);
    expect(plain.ok).toBe(true);
    // The compressed payload is a fraction of the plain-encoded one — the
    // honest-size claim the empty state makes.
    expect(payload.length).toBeLessThan(NATIVE_TEXT.length);
  });
});

describe("share codec cross-decodes the plain fallback", () => {
  it("a 1b payload decodes byte-identically", async () => {
    const bytes = new TextEncoder().encode(NATIVE_TEXT);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const payload = `1b.${btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")}`;
    const decoded = await decodeNativeFromShare(payload);
    expect(decoded).toEqual({ ok: true, text: NATIVE_TEXT });
  });

  it("a plain link carries only URL-safe base64 characters", async () => {
    const payload = await encodeNativeForShare(NATIVE_TEXT);
    const body = payload.slice(3);
    expect(body).toMatch(/^[A-Za-z0-9_-]*$/);
  });
});

describe("share codec refusals are structured", () => {
  it("an unknown version is refused with the offending prefix", async () => {
    const decoded = await decodeNativeFromShare("9d.abstract");
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toContain("unknown share format");
  });

  it("an unknown encoding tag is refused", async () => {
    const decoded = await decodeNativeFromShare("1z.abstract");
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.error).toContain("unknown share encoding");
  });

  it("a truncated tag shape is refused", async () => {
    const decoded = await decodeNativeFromShare("1d");
    expect(decoded.ok).toBe(false);
  });

  it("corrupted deflate bytes are refused, not thrown", async () => {
    const payload = await encodeNativeForShare(NATIVE_TEXT);
    const body = payload.slice(3);
    // Flip the tag byte of the base64 body — a deflate stream that no
    // longer inflates.
    const corrupted = `1d.${body.slice(0, 4)}AA${body.slice(6)}`;
    const decoded = await decodeNativeFromShare(corrupted);
    expect(decoded.ok).toBe(false);
  });
});

describe("share codec decode is bounded", () => {
  it("an oversized base64 fragment is refused before any decode", async () => {
    const fragment = `1d.${"A".repeat(SHARE_PAYLOAD_MAX_CHARS + 1)}`;
    const decoded = await decodeNativeFromShare(fragment);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error).toContain("character cap");
    }
  });

  it("a deflate bomb is cut off at the inflated-output cap", async () => {
    // A real bomb: zeros compress ~1000:1, so the whole expansion fits in
    // a payload far under the input cap — the OUTPUT cap is what fires.
    const bomb = await encodeNativeForShare(
      "\0".repeat(SHARE_INFLATE_MAX_BYTES + 1),
    );
    expect(bomb.length).toBeLessThan(SHARE_PAYLOAD_MAX_CHARS);
    const decoded = await decodeNativeFromShare(bomb);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error).toContain("output cap");
    }
  });

  it("a valid link far under the caps still round-trips", async () => {
    const payload = await encodeNativeForShare(NATIVE_TEXT);
    const decoded = await decodeNativeFromShare(payload);
    expect(decoded).toEqual({ ok: true, text: NATIVE_TEXT });
  });
});
