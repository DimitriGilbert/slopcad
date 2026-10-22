/**
 * `crypto.randomUUID` with an insecure-context fallback. `randomUUID` is a
 * secure-context-only method: served over plain HTTP on a LAN origin it is
 * absent at runtime (`globalThis.crypto.randomUUID is not a function`),
 * while `crypto.getRandomValues` remains available in EVERY context. The
 * fallback mints an RFC 4122 §4.4 version-4 UUID from `getRandomValues`,
 * setting the version (byte 6, high nibble) and variant (byte 8, top bits)
 * fields by hand.
 */

/** A random v4 UUID built from `getRandomValues` alone. */
function randomUuidV4(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A random UUID in every context: the native `crypto.randomUUID()` when the
 * method exists, the `getRandomValues`-built v4 otherwise.
 */
export function randomUUID(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return randomUuidV4();
}
