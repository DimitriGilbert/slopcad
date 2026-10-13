/**
 * The share codec (Phase — shareable parametric pages): the URL hash
 * fragment format a /viewer link carries the native document in.
 *
 * The shared page has NO server storage: the entire native document rides
 * in the fragment, so a link survives any medium and leaks nothing to the
 * server. The native text for a real part is 10–20 KB, which base64-encodes
 * to an unwieldy URL — so the default encoding DEFLATEs the UTF-8 bytes
 * first (the browser's own `CompressionStream`, available in every current
 * browser) and base64url-encodes the result. A link stays honest about its
 * cost: the payload is a few KB for a typical part, and the page's empty
 * state says so in those words (see {@link SHARE_FORMAT_NOTE}).
 *
 * Fragment grammar (after the leading `#`):
 *
 *     1d.<base64url>   — deflate-raw compressed, the default
 *     1b.<base64url>   — plain UTF-8 bytes, the fallback for browsers
 *                        without CompressionStream
 *
 * `1` is the format version; a future encoding bumps it and the decoder
 * refuses unknown versions with a structured error instead of guessing.
 * Decoding accepts the payload with or without the leading `#` and sniffs
 * the encoding tag, so a `1b` link made by a fallback browser decodes
 * everywhere.
 *
 * The route is public and deliberately framable by any page, so the
 * fragment is fully attacker-chosen input; decoding is therefore BOUNDED
 * — a ceiling on the accepted payload text and a ceiling on the inflated
 * output — so a crafted deflate bomb is refused by arithmetic and lands
 * in the structured error state, never an out-of-memory tab (see
 * {@link SHARE_PAYLOAD_MAX_CHARS} and {@link SHARE_INFLATE_MAX_BYTES}).
 */

/** The fragment format version (bumped when the encoding ever changes). */
const FORMAT_VERSION = "1";

/** The deflate tag: the default encoding when CompressionStream exists. */
const TAG_DEFLATE = "d";

/** The plain tag: the fallback encoding. */
const TAG_PLAIN = "b";

/** What the UI tells the user about link size (honest limits, no surprises). */
export const SHARE_FORMAT_NOTE =
  "Share links carry the whole part in the URL (deflate-compressed, a few KB for a typical part). Very large documents can outgrow browser URL limits.";

/**
 * The longest base64 fragment body the decoder accepts: 8 MiB (2²³
 * characters). The payload rides one URL navigation and browsers refuse
 * URLs far shorter than this anyway, while a real part's native text is
 * 10–20 KB (a few KB compressed) — so anything longer is not a share
 * link but an input bomb. Checked before any base64 decode or inflate,
 * the way the 3MF importer pre-checks a declared size before inflating.
 */
export const SHARE_PAYLOAD_MAX_CHARS = 2 ** 23;

/**
 * The most bytes one decode may inflate to: 64 MiB (2²⁶) of UTF-8 native
 * text — orders of magnitude beyond any real document, generous enough
 * that no legitimate link ever trips it. Enforced as a running counter
 * inside the read loop (the streaming twin of zlib's `maxOutputLength`
 * the importer passes), so a deflate bomb's allocation stops at the cap
 * instead of draining the whole expansion into memory first.
 */
export const SHARE_INFLATE_MAX_BYTES = 2 ** 26;

/** A decode refusal: the tag/version shape or the bytes themselves. */
export type ShareDecodeResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: string };

/** UTF-8 bytes of `text`. */
function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** base64url of `bytes` (no padding; chunked so large payloads never blow
 * the function-call stack through `String.fromCharCode(...spread)`). */
function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let start = 0; start < bytes.length; start += chunk) {
    const slice = bytes.subarray(start, start + chunk);
    let part = "";
    for (const byte of slice) part += String.fromCharCode(byte);
    binary += part;
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** Inverse of {@link toBase64Url}; restores any stripped padding. */
function fromBase64Url(payload: string): Uint8Array {
  const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** True when the browser exposes the compression streams API. */
function compressionAvailable(): boolean {
  return (
    typeof CompressionStream === "function" &&
    typeof DecompressionStream === "function"
  );
}

/** A one-chunk readable of `bytes` (no Response/Blob dependency — the
 * codec runs in the browser AND the unit-test runtime alike). */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Internal control-flow carrier: thrown by the bounded drain the moment
 * the inflated-output ceiling is crossed, and caught at the single decode
 * entry point so the public function stays total — a structured refusal,
 * never an escaping opaque error (the 3MF importer's `ImportReject`
 * pattern). Never escapes `decodeNativeFromShare`.
 */
class InflateCapExceeded extends Error {
  constructor(bytes: number) {
    super(
      `payload inflates past the ${SHARE_INFLATE_MAX_BYTES}-byte output cap (saw ${bytes})`,
    );
    this.name = "InflateCapExceeded";
  }
}

/**
 * Drains a stream into one byte array. `maxBytes` is the running
 * accumulation ceiling: the moment the summed chunk lengths cross it, the
 * reader is cancelled (the pipe stops inflating) and an
 * {@link InflateCapExceeded} thrown — a decompression bomb is stopped by
 * arithmetic mid-loop, allocating at most the cap, never the full
 * expansion. Unbounded by default: the encode path drains its own
 * trusted, input-sized output.
 */
async function drain(
  stream: ReadableStream<Uint8Array>,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.length;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new InflateCapExceeded(total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The platform stream pair's type as the DOM lib declares it: the
 * compression streams read/write `BufferSource`, one `Uint8Array` view
 * width apart from {@link streamOf}'s chunks — the runtime contract is
 * byte streams; the bridge keeps the pipeThrough call type-honest.
 */
type CompressionPair = ReadableWritablePair<
  Uint8Array<ArrayBuffer>,
  Uint8Array<ArrayBuffer>
>;

/** Deflate-raw compresses `bytes` through the platform stream. */
async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const pair = new CompressionStream(
    "deflate-raw",
  ) as unknown as CompressionPair;
  return drain(streamOf(bytes).pipeThrough(pair));
}

/** Inflates a deflate-raw payload through the platform stream, bounded
 * by the share decode output cap (untrusted input — see
 * {@link SHARE_INFLATE_MAX_BYTES}). */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const pair = new DecompressionStream(
    "deflate-raw",
  ) as unknown as CompressionPair;
  return drain(streamOf(bytes).pipeThrough(pair), SHARE_INFLATE_MAX_BYTES);
}

/**
 * Encodes native document text into the fragment payload (without the
 * `#`): deflate + base64url when the platform offers CompressionStream,
 * the plain base64url fallback otherwise. Both decode everywhere.
 */
export async function encodeNativeForShare(
  nativeText: string,
): Promise<string> {
  const bytes = encodeUtf8(nativeText);
  if (!compressionAvailable()) {
    return `${FORMAT_VERSION}${TAG_PLAIN}.${toBase64Url(bytes)}`;
  }
  return `${FORMAT_VERSION}${TAG_DEFLATE}.${toBase64Url(await deflateRaw(bytes))}`;
}

/**
 * The site path of a share link: everything after the origin. The route is
 * public and framable; the payload rides the fragment (never sent to any
 * server).
 */
export function buildSharePath(payload: string): string {
  return `/viewer#${payload}`;
}

/**
 * Decodes a fragment payload (with or without the leading `#`) back to the
 * native text. Refusals are structured: an unknown version/encoding tag,
 * an oversized payload ({@link SHARE_PAYLOAD_MAX_CHARS}), undecodable
 * bytes, or an inflate past the output cap
 * ({@link SHARE_INFLATE_MAX_BYTES}) never surface as a thrown opaque
 * error — the caller's `setLoadError` degrade renders them instead.
 */
export async function decodeNativeFromShare(
  fragment: string,
): Promise<ShareDecodeResult> {
  const payload = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  // The grammar: version char, encoding tag, the `.` separator, payload.
  const version = payload.slice(0, FORMAT_VERSION.length);
  const tag = payload.slice(FORMAT_VERSION.length, FORMAT_VERSION.length + 1);
  const separator = payload.slice(
    FORMAT_VERSION.length + 1,
    FORMAT_VERSION.length + 2,
  );
  const rest = payload.slice(FORMAT_VERSION.length + 2);
  if (version !== FORMAT_VERSION || separator !== "." || rest === "") {
    return { ok: false, error: `unknown share format: ${payload.slice(0, 8)}` };
  }
  // The declared-size pre-check: refuse an oversized fragment by
  // arithmetic, before any base64 decode or inflate can allocate.
  if (rest.length > SHARE_PAYLOAD_MAX_CHARS) {
    return {
      ok: false,
      error: `share payload of ${rest.length} characters exceeds the ${SHARE_PAYLOAD_MAX_CHARS}-character cap`,
    };
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(rest);
  } catch (error) {
    return {
      ok: false,
      error: `share payload is not decodable base64: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  try {
    if (tag === TAG_DEFLATE) {
      return {
        ok: true,
        text: new TextDecoder().decode(await inflateRaw(bytes)),
      };
    }
    if (tag === TAG_PLAIN) {
      return { ok: true, text: new TextDecoder().decode(bytes) };
    }
    return { ok: false, error: `unknown share encoding: ${tag}` };
  } catch (error) {
    return {
      ok: false,
      error: `share payload failed to decode: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
