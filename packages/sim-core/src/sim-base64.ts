/**
 * The sim worker protocol's byte codec (Phase 61b): strict RFC 4648 base64
 * for carrying binary payload bytes across the wire, where every message
 * must survive `value → JSON → value` unchanged.
 *
 * The `sim.finalize` result carries a {@link SimResult} payload block set as
 * its deterministic binary bytes, and field-chunk notifications carry chunk
 * values as the raw little-endian float bytes of the payload layout — JSON
 * has no byte type, so the serialized form is base64 text. The codec is the
 * kernel protocol's `worker-base64` restated verbatim (sim-core depends on
 * nothing at runtime): written by hand — not via `atob`/`Buffer` — so it
 * behaves identically in the browser, Node, vitest, and a worker, with no
 * dependency and no environment branching. Encoding is canonical (standard
 * alphabet, padded, no line breaks); decoding is STRICT: anything else —
 * wrong alphabet, wrong length, misplaced padding, embedded whitespace — is
 * rejected instead of being silently repaired, because the input crossed a
 * trust boundary and the parser's job is to fail it, not to guess.
 */

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const CHAR_TO_VALUE = new Map<string, number>(
  [...ALPHABET].map((character, index) => [character, index] as const),
);

/**
 * Encodes bytes to the canonical RFC 4648 base64 text: standard alphabet,
 * `=` padding to a multiple of four characters, no separators. Deterministic
 * — the same bytes always produce the same text.
 */
export function encodeSimBase64(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const b0 = bytes[offset] ?? 0;
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    text += ALPHABET[(triple >> 18) & 0x3f];
    text += ALPHABET[(triple >> 12) & 0x3f];
    text += b1 === undefined ? "=" : ALPHABET[(triple >> 6) & 0x3f];
    text += b2 === undefined ? "=" : ALPHABET[triple & 0x3f];
  }
  return text;
}

/**
 * Decodes strict canonical base64 text to bytes, or `null` when the text is
 * not exactly that: the character set, length, and padding placement must all
 * match the encoder's output form (padding only in the last one or two
 * positions, never followed by an alphabet character). The empty text is the
 * canonical encoding of the empty bytes, not a defect. Never throws.
 */
export function decodeSimBase64Strict(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) {
    return null;
  }
  let padding = 0;
  for (let position = 0; position < text.length; position += 1) {
    const character = text[position];
    if (character === undefined) return null;
    if (CHAR_TO_VALUE.has(character)) {
      if (padding > 0) return null; // alphabet after padding: non-canonical.
      continue;
    }
    if (character === "=" && position >= text.length - 2) {
      padding += 1;
      continue;
    }
    return null;
  }
  // The position rule above bounds padding to the last two slots, so the
  // canonical forms are exactly: no padding, one `=`, or two `=` bytes.
  const byteLength = (text.length / 4) * 3 - padding;
  const bytes = new Uint8Array(byteLength);
  let accumulator = 0;
  let bits = 0;
  let written = 0;
  for (const character of text) {
    if (character === "=") continue;
    const value = CHAR_TO_VALUE.get(character);
    if (value === undefined) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      const byte = (accumulator >> bits) & 0xff;
      const target = bytes[written];
      if (target === undefined) return null;
      bytes[written] = byte;
      written += 1;
    }
  }
  if (written !== byteLength) return null;
  return bytes;
}
