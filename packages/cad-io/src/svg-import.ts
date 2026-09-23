/**
 * SVG import (Phase 56): parses untrusted ASCII `.svg` bytes into
 * cad-sketch entities (the Phase 36 vocabulary) in canonical millimetres,
 * plus the honest provenance the subset discipline owes the caller.
 *
 * ## Pinned subset (the honesty boundary)
 *
 * A 2D vector-exchange subset, exact — no sampling, no flattening:
 *
 * - **`<line x1 y1 x2 y2>`** → `line`.
 * - **`<circle cx cy r>`** → `circle` (r must be finite and > 0).
 * - **`<ellipse rx ry>`** → `circle` when `rx === ry` (the only case an
 *   exact circular entity exists); otherwise declined.
 * - **`<rect x y width height>`** → four `line` edges in outline order
 *   (`-s0…-s3` suffixed ids); zero width/height fails.
 * - **`<path d>`** — commands `M m L l H h V v C c Q q A a Z z`, with the
 *   grammar's implicit repetition (extra coordinate groups after `M`/`L`
 *   repeat the command; after `m` they are relative lines). Each segment
 *   becomes one exact entity:
 *   - `L/l/H/h/V` → `line`; `Z/z` closes the subpath with a line.
 *   - `C/c` → `spline` (`control` flavor, 4 points) — the exact cubic.
 *   - `Q/q` → the exact degree-elevated cubic (quadratic → cubic is an
 *     identity: `c1 = (p0+2·p1)/3`, `c2 = (2·p1+p2)/3`), then as `C`.
 *   - `A/a` → `arc` via the SVG appendix's endpoint→center
 *     parameterization (exact algebra, including the out-of-range-radii
 *     scaling the spec defines), when the arc is circular (`rx === ry`)
 *     and unrotated (`x-axis-rotation` = 0). A zero radius per the spec
 *     degenerates to a line and is taken as such. `rx ≠ ry` or a nonzero
 *     rotation declines with `arc-out-of-subset` — cad-sketch's
 *     elliptical-arc entity takes parametric angles this importer does
 *     not translate (fabrication risk, declined).
 *   - `S/s`/`T/t` (reflected-control shorthands) decline with
 *     `command-out-of-subset`; the reflection state they need is per-
 *     command bookkeeping this pinned subset does not carry. The rest of
 *     the path still imports.
 *
 * Every other element (`<text>`, `<g>`, `<image>`, …) is recorded in
 * {@link ImportedSvgSketch.declined} with `element-out-of-subset`; an
 * element carrying a `transform` attribute declines with
 * `transform-out-of-subset` — applying it is exact math this pinned
 * subset does not perform — and the rest of the file imports. Scope
 * boundaries decline; defects reject: a non-finite coordinate inside an
 * in-subset element is a whole-file failure (`svg-import/invalid-number`).
 *
 * ## Coordinates, viewBox, ids
 *
 * SVG's y axis points down; the sketch plane is y-up like DXF. Every
 * coordinate mirrors: `Y_sketch = -(y_svg - viewBox.y)`. The `viewBox`
 * (when present) contributes its origin as a translation; user units are
 * millimetres 1:1 — the documented convention (matching OBJ), and
 * `width`/`height` are display hints, ignored. A viewBox that is not
 * four finite numbers fails (`svg-import/invalid-viewbox`). Ids mint from
 * the element's document order: `skent_svg<N>`, segments suffixed
 * `-s<k>` — `s`/`v`/`g` are not hex digits, so minted ids never collide
 * with handle-minted ones.
 *
 * ## Framing and failure discipline
 *
 * The XML is read with a narrow scanner: comments stripped, elements via
 * a tag/attribute scan. Binary bytes, empty input, a file with no `<svg`
 * root, and a malformed viewBox fail with structured `svg-import/*`
 * codes on the cad-core `ParseResult` discipline — no byte input throws.
 * Deterministic: one pass, fixed order, no time, no randomness.
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import {
  createArcEntity,
  createCircleEntity,
  createLineEntity,
  createSketchEntityId,
  createSplineEntity,
  type SketchEntity,
  type SketchEntityId,
} from "@slopcad/cad-sketch";

/** Stable failure codes produced when SVG import rejects its input. */
export const SVG_IMPORT_ERROR_CODES = {
  empty: "svg-import/empty",
  binaryUnsupported: "svg-import/binary-unsupported",
  notSvg: "svg-import/not-svg",
  invalidViewbox: "svg-import/invalid-viewbox",
  invalidNumber: "svg-import/invalid-number",
} as const;

export type SvgImportErrorCode =
  (typeof SVG_IMPORT_ERROR_CODES)[keyof typeof SVG_IMPORT_ERROR_CODES];

/** Structured failure describing why SVG import rejected some bytes. */
export interface SvgImportError extends ParseFailure {
  readonly code: SvgImportErrorCode;
}

/** One element the pinned subset does not cover, recorded instead of imported. */
export interface SvgDeclinedElement {
  readonly kind: string;
  readonly reason:
    | "element-out-of-subset"
    | "transform-out-of-subset"
    | "command-out-of-subset"
    | "arc-out-of-subset";
}

/** The successful result of importing an SVG file. */
export interface ImportedSvgSketch {
  readonly entities: readonly SketchEntity[];
  readonly units: "mm";
  /** The root viewBox origin (its x/y), or null when the root has none. */
  readonly viewBox: { readonly x: number; readonly y: number } | null;
  readonly declined: readonly SvgDeclinedElement[];
}

/** The result of SVG import: an imported sketch, or a structured failure. */
export type SvgImportResult = ParseResult<ImportedSvgSketch, SvgImportError>;

function svgError(
  code: SvgImportErrorCode,
  message: string,
  bytes: Uint8Array,
): SvgImportError {
  return { code, message, input: bytes };
}

/** Whether every byte is text ASCII SVG can carry. */
function isDecodableText(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] ?? 0;
    if (
      byte === 0x09 ||
      byte === 0x0a ||
      byte === 0x0d ||
      (byte >= 0x20 && byte <= 0x7e)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/** SVG double reader: decimal/exponent forms, finiteness enforced. */
function readDouble(token: string): number | null {
  const parsed = Number.parseFloat(token);
  return Number.isFinite(parsed) ? parsed : null;
}

/** One scanned element: tag name, attributes, and inherited transform state. */
interface ScannedElement {
  readonly tag: string;
  readonly attributes: ReadonlyMap<string, string>;
  /** True when the element or an open ancestor carries a transform. */
  readonly transformed: boolean;
}

/**
 * Tag walker: comments stripped, then every tag in document order with an
 * open-element stack. Transform state INHERITS: a child of a transformed
 * `<g>` is marked transformed too — importing its coordinates as-is would
 * fabricate geometry in the wrong place, so such elements decline. Closing
 * tags pop the stack; a mismatched or unclosed tag at worst mis-scopes a
 * decline in the conservative direction (a leftover stack entry keeps its
 * subtree declined only while tags stay balanced, which the dangling-markup
 * guard below enforces for anything it cannot read).
 */
function scanElements(
  text: string,
  bytes: Uint8Array,
): ParseResult<readonly ScannedElement[], SvgImportError> {
  const withoutComments = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[^>]*\?>/g, "");
  const elements: ScannedElement[] = [];
  const openTags: { readonly tag: string; readonly transformed: boolean }[] =
    [];
  const tagPattern =
    /<(\/?)([a-zA-Z][a-zA-Z0-9:.-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=>]+))?)*)\s*(\/?)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(withoutComments)) !== null) {
    const closing = (match[1] ?? "") === "/";
    const tag = (match[2] ?? "").toLowerCase();
    const attributeText = match[3] ?? "";
    const selfClosing = (match[4] ?? "") === "/";
    if (closing) {
      const top = openTags.pop();
      if (top === undefined || top.tag !== tag) {
        return fail(
          svgError(
            SVG_IMPORT_ERROR_CODES.notSvg,
            `The file's tags are not balanced (closing ${JSON.stringify(tag)}); refusing to guess at nesting.`,
            bytes,
          ),
        );
      }
      continue;
    }
    const attributes = new Map<string, string>();
    const attributePattern =
      /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=>]+))/g;
    let attribute: RegExpExecArray | null;
    while ((attribute = attributePattern.exec(attributeText)) !== null) {
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      attributes.set((attribute[1] ?? "").toLowerCase(), value);
    }
    const inherited = openTags.some((open) => open.transformed);
    const transformed = inherited || attributes.has("transform");
    elements.push({ tag, attributes, transformed });
    if (!selfClosing) openTags.push({ tag, transformed });
  }
  if (openTags.length > 0) {
    return fail(
      svgError(
        SVG_IMPORT_ERROR_CODES.notSvg,
        `The file ends with ${String(openTags.length)} unclosed element(s); refusing to guess at nesting.`,
        bytes,
      ),
    );
  }
  const dangling = withoutComments.replace(tagPattern, "");
  if (/<[a-zA-Z]/.test(dangling)) {
    return fail(
      svgError(
        SVG_IMPORT_ERROR_CODES.notSvg,
        "The file carries markup the scanner cannot read (unclosed or malformed tags); refusing to guess.",
        bytes,
      ),
    );
  }
  return ok(elements);
}

/** Reads a numeric attribute: null = present-but-invalid, undefined = absent. */
function numberAttribute(
  attributes: ReadonlyMap<string, string>,
  name: string,
): number | null | undefined {
  const raw = attributes.get(name);
  if (raw === undefined) return undefined;
  return readDouble(raw.trim());
}

/** Requires a finite attribute; a non-finite value is a whole-file defect. */
function requireNumber(
  attributes: ReadonlyMap<string, string>,
  name: string,
  bytes: Uint8Array,
  context: string,
): { value?: number; failure?: SvgImportError } {
  const parsed = numberAttribute(attributes, name);
  if (parsed === undefined) {
    return {
      failure: svgError(
        SVG_IMPORT_ERROR_CODES.invalidNumber,
        `${context} is missing its ${JSON.stringify(name)} coordinate.`,
        bytes,
      ),
    };
  }
  if (parsed === null) {
    return {
      failure: svgError(
        SVG_IMPORT_ERROR_CODES.invalidNumber,
        `${context} has a non-finite ${JSON.stringify(name)}: ${JSON.stringify(attributes.get(name) ?? "")}.`,
        bytes,
      ),
    };
  }
  return { value: parsed };
}

/** Mirrors an SVG point into sketch coordinates (y-down → y-up, origin). */
interface Frame {
  readonly originX: number;
  readonly originY: number;
}

function toSketch(
  frame: Frame,
  x: number,
  y: number,
): { x: number; y: number } {
  // `+ 0` normalizes the mirror's -0 to 0 so sketch bytes compare equal.
  return { x: x - frame.originX + 0, y: -(y - frame.originY) + 0 };
}

// ---------------------------------------------------------------------------
// Path data
// ---------------------------------------------------------------------------

type PathOutcome =
  | { readonly tag: "entities"; readonly entities: readonly SketchEntity[] }
  | { readonly tag: "declined"; readonly reason: SvgDeclinedElement["reason"] }
  | { readonly tag: "invalid"; readonly message: string };

/** Tokens of a path `d` string: command letters and numbers, in order. */
function tokenizePath(data: string): readonly string[] {
  return (
    data.match(
      /[MmLlHhVvCcSsQqAaTtZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g,
    ) ?? []
  );
}

/** Converts one circular `A` segment via the SVG appendix F.6.5 algebra. */
function arcSegment(
  frame: Frame,
  id: SketchEntityId,
  start: { readonly x: number; readonly y: number },
  end: { readonly x: number; readonly y: number },
  radius: number,
  largeArc: boolean,
  sweep: boolean,
): SketchEntity | null {
  // F.6.2 with rx = ry = r (out-of-range radii scale up first).
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const chordSq = dx * dx + dy * dy;
  const r =
    chordSq > radius * radius
      ? radius * Math.sqrt(chordSq / (radius * radius))
      : radius;
  const root = r * r - chordSq;
  const sign = largeArc !== sweep ? 1 : -1;
  const co = Math.sqrt(Math.max(root, 0)) * sign;
  // Center in SVG coordinates (y-down), then mirrored through the frame.
  const svgCx = co * (dy / r) + (start.x + end.x) / 2;
  const svgCy = (-co * dx) / r + (start.y + end.y) / 2;
  const center = toSketch(frame, svgCx, svgCy);
  const a1 = Math.atan2(-(start.y - svgCy), start.x - svgCx);
  const a2 = Math.atan2(-(end.y - svgCy), end.x - svgCx);
  // SVG sweep=1 is positive-angle in y-down = CCW after mirroring; sweep=0
  // mirrors to CW, i.e. the same arc CCW from the other endpoint.
  const [startAngle, endAngle] = sweep ? [a1, a2] : [a2, a1];
  try {
    return createArcEntity(id, center, r, startAngle, endAngle);
  } catch {
    return null;
  }
}

/** Converts one `d` attribute into sketch entities (or a decline/failure). */
function convertPath(
  frame: Frame,
  id: SketchEntityId,
  data: string,
): PathOutcome {
  const tokens = tokenizePath(data);
  if (tokens.length === 0) {
    return { tag: "invalid", message: "an empty path data string" };
  }
  const entities: SketchEntity[] = [];
  let suffix = 0;
  const nextId = (): SketchEntityId =>
    suffix === 0 ? id : createSketchEntityId(`${id}-s${String(suffix)}`);

  let index = 0;
  let command = "";
  // Current point (SVG coordinates); subpath start for Z.
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let started = false;

  const readNumber = (): number | null => {
    const token = tokens[index];
    index += 1;
    if (token === undefined) return null;
    const parsed = Number.parseFloat(token);
    return Number.isFinite(parsed) ? parsed : null;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) break;
    if (/[MmLlHhVvCcSsQqAaTtZz]/.test(token)) {
      command = token;
      index += 1;
      if (command === "Z" || command === "z") {
        if (started && (cx !== startX || cy !== startY)) {
          const a = toSketch(frame, cx, cy);
          const b = toSketch(frame, startX, startY);
          try {
            entities.push(createLineEntity(nextId(), a, b));
            suffix += 1;
          } catch {
            return {
              tag: "invalid",
              message: "a closing segment failed conversion",
            };
          }
        }
        cx = startX;
        cy = startY;
        continue;
      }
    } else if (command === "") {
      return {
        tag: "invalid",
        message: `path data starts with ${JSON.stringify(token)}`,
      };
    }

    if (command === "M" || command === "m") {
      const x = readNumber();
      const y = readNumber();
      if (x === null || y === null) {
        return { tag: "invalid", message: "a moveto is missing coordinates" };
      }
      const absolute = command === "M";
      cx = absolute ? x : cx + x;
      cy = absolute ? y : cy + y;
      if (!started) {
        startX = cx;
        startY = cy;
        started = true;
      }
      // Implicit repeats after M are lines (per the grammar).
      command = absolute ? "L" : "l";
      continue;
    }

    if (command === "L" || command === "l") {
      const x = readNumber();
      const y = readNumber();
      if (x === null || y === null) {
        return { tag: "invalid", message: "a lineto is missing coordinates" };
      }
      const nx = command === "L" ? x : cx + x;
      const ny = command === "L" ? y : cy + y;
      try {
        entities.push(
          createLineEntity(
            nextId(),
            toSketch(frame, cx, cy),
            toSketch(frame, nx, ny),
          ),
        );
      } catch {
        return { tag: "invalid", message: "a lineto failed conversion" };
      }
      suffix += 1;
      cx = nx;
      cy = ny;
      continue;
    }

    if (command === "H" || command === "h") {
      const x = readNumber();
      if (x === null)
        return {
          tag: "invalid",
          message: "a horizontal lineto is missing its x",
        };
      const nx = command === "H" ? x : cx + x;
      try {
        entities.push(
          createLineEntity(
            nextId(),
            toSketch(frame, cx, cy),
            toSketch(frame, nx, cy),
          ),
        );
      } catch {
        return {
          tag: "invalid",
          message: "a horizontal lineto failed conversion",
        };
      }
      suffix += 1;
      cx = nx;
      continue;
    }

    if (command === "V" || command === "v") {
      const y = readNumber();
      if (y === null)
        return {
          tag: "invalid",
          message: "a vertical lineto is missing its y",
        };
      const ny = command === "V" ? y : cy + y;
      try {
        entities.push(
          createLineEntity(
            nextId(),
            toSketch(frame, cx, cy),
            toSketch(frame, cx, ny),
          ),
        );
      } catch {
        return {
          tag: "invalid",
          message: "a vertical lineto failed conversion",
        };
      }
      suffix += 1;
      cy = ny;
      continue;
    }

    if (command === "C" || command === "c") {
      const values: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        const value = readNumber();
        if (value === null) {
          return {
            tag: "invalid",
            message: "a curveto is missing coordinates",
          };
        }
        values.push(value);
      }
      const [x1, y1, x2, y2, x, y] = values as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
      const rel = command === "c";
      const p0 = toSketch(frame, cx, cy);
      const p1 = toSketch(frame, rel ? cx + x1 : x1, rel ? cy + y1 : y1);
      const p2 = toSketch(frame, rel ? cx + x2 : x2, rel ? cy + y2 : y2);
      const p3 = toSketch(frame, rel ? cx + x : x, rel ? cy + y : y);
      try {
        entities.push(
          createSplineEntity(nextId(), "control", [p0, p1, p2, p3]),
        );
      } catch {
        return { tag: "invalid", message: "a curveto failed conversion" };
      }
      suffix += 1;
      cx = rel ? cx + x : x;
      cy = rel ? cy + y : y;
      continue;
    }

    if (command === "Q" || command === "q") {
      const values: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const value = readNumber();
        if (value === null) {
          return {
            tag: "invalid",
            message: "a quadratic curveto is missing coordinates",
          };
        }
        values.push(value);
      }
      const [x1, y1, x, y] = values as [number, number, number, number];
      const rel = command === "q";
      const p0 = { x: cx, y: cy };
      const p1 = { x: rel ? cx + x1 : x1, y: rel ? cy + y1 : y1 };
      const p3 = { x: rel ? cx + x : x, y: rel ? cy + y : y };
      // Exact degree elevation: the cubic (p0, c1, c2, p3) reproduces the
      // quadratic through the same endpoints and control point.
      const c1 = { x: (p0.x + 2 * p1.x) / 3, y: (p0.y + 2 * p1.y) / 3 };
      const c2 = { x: (2 * p1.x + p3.x) / 3, y: (2 * p1.y + p3.y) / 3 };
      try {
        entities.push(
          createSplineEntity(
            nextId(),
            "control",
            [p0, c1, c2, p3].map((point) => toSketch(frame, point.x, point.y)),
          ),
        );
      } catch {
        return {
          tag: "invalid",
          message: "a quadratic curveto failed conversion",
        };
      }
      suffix += 1;
      cx = p3.x;
      cy = p3.y;
      continue;
    }

    if (command === "A" || command === "a") {
      const values: (number | null)[] = [];
      for (let i = 0; i < 7; i += 1) {
        values.push(readNumber());
      }
      if (values.some((value) => value === null)) {
        return {
          tag: "invalid",
          message: "an arc is missing its seven parameters",
        };
      }
      const rx = values[0] ?? 0;
      const ry = values[1] ?? 0;
      const rotation = values[2] ?? 0;
      const largeArc = (values[3] ?? 0) !== 0;
      const sweep = (values[4] ?? 0) !== 0;
      const x = values[5] ?? 0;
      const y = values[6] ?? 0;
      const rel = command === "a";
      const nx = rel ? cx + x : x;
      const ny = rel ? cy + y : y;
      if (!Number.isInteger(values[3]) || !Number.isInteger(values[4])) {
        return {
          tag: "invalid",
          message: "an arc's large-arc/sweep flags are not integers",
        };
      }
      if (rotation % 360 !== 0) {
        return { tag: "declined", reason: "arc-out-of-subset" };
      }
      if (rx === 0 || ry === 0) {
        // Per the SVG grammar a zero-radius arc degenerates to a line.
        try {
          entities.push(
            createLineEntity(
              nextId(),
              toSketch(frame, cx, cy),
              toSketch(frame, nx, ny),
            ),
          );
        } catch {
          return {
            tag: "invalid",
            message: "a degenerate arc failed conversion",
          };
        }
        suffix += 1;
        cx = nx;
        cy = ny;
        continue;
      }
      if (rx !== ry) {
        return { tag: "declined", reason: "arc-out-of-subset" };
      }
      const arc = arcSegment(
        frame,
        nextId(),
        { x: cx, y: cy },
        { x: nx, y: ny },
        rx,
        largeArc,
        sweep,
      );
      if (arc === null) {
        return {
          tag: "invalid",
          message: "an arc failed its center parameterization",
        };
      }
      entities.push(arc);
      suffix += 1;
      cx = nx;
      cy = ny;
      continue;
    }

    if (
      command === "S" ||
      command === "s" ||
      command === "T" ||
      command === "t"
    ) {
      return { tag: "declined", reason: "command-out-of-subset" };
    }

    return {
      tag: "invalid",
      message: `a bare number follows command ${JSON.stringify(command)}`,
    };
  }

  return { tag: "entities", entities };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Imports `bytes` as an ASCII SVG file into an {@link ImportedSvgSketch}.
 * Total over byte inputs: either imports or fails with a structured
 * `svg-import/*` code — never a throw. Deterministic: one pass, fixed
 * order, no time, no randomness.
 */
export function importSvg(bytes: Uint8Array): SvgImportResult {
  if (bytes.byteLength === 0) {
    return fail(
      svgError(
        SVG_IMPORT_ERROR_CODES.empty,
        "The input is empty (0 bytes); there is no SVG to import.",
        bytes,
      ),
    );
  }
  if (!isDecodableText(bytes)) {
    return fail(
      svgError(
        SVG_IMPORT_ERROR_CODES.binaryUnsupported,
        "The input carries bytes no ASCII SVG can; this importer reads ASCII SVG only.",
        bytes,
      ),
    );
  }
  const text = new TextDecoder("latin1").decode(bytes);
  if (!/<svg[\s>]/i.test(text)) {
    return fail(
      svgError(
        SVG_IMPORT_ERROR_CODES.notSvg,
        "The file has no <svg> root element; it is not SVG.",
        bytes,
      ),
    );
  }
  const scanned = scanElements(text, bytes);
  if (!scanned.ok) return scanned;

  // --- viewBox: the user-space origin (translation only, y mirrored). ---
  let frame: Frame = { originX: 0, originY: 0 };
  const root = scanned.value.find((element) => element.tag === "svg");
  const viewBoxRaw = root?.attributes.get("viewbox");
  if (viewBoxRaw !== undefined) {
    const parts = viewBoxRaw.trim().split(/[\s,]+/);
    if (parts.length !== 4 || parts.some((part) => readDouble(part) === null)) {
      return fail(
        svgError(
          SVG_IMPORT_ERROR_CODES.invalidViewbox,
          `The root viewBox ${JSON.stringify(viewBoxRaw)} is not four finite numbers.`,
          bytes,
        ),
      );
    }
    frame = {
      originX: readDouble(parts[0] ?? "0") ?? 0,
      originY: readDouble(parts[1] ?? "0") ?? 0,
    };
  }

  const entities: SketchEntity[] = [];
  const declined: SvgDeclinedElement[] = [];
  let counter = 0;

  for (const element of scanned.value) {
    if (element.tag === "svg") continue;
    if (element.transformed) {
      declined.push({ kind: element.tag, reason: "transform-out-of-subset" });
      continue;
    }
    const id = `skent_svg${String(counter)}` as SketchEntityId;
    const context = `Element <${element.tag}> #${String(counter)}`;
    counter += 1;

    if (element.tag === "line") {
      const x1 = requireNumber(element.attributes, "x1", bytes, context);
      if (x1.failure) return fail(x1.failure);
      const y1 = requireNumber(element.attributes, "y1", bytes, context);
      if (y1.failure) return fail(y1.failure);
      const x2 = requireNumber(element.attributes, "x2", bytes, context);
      if (x2.failure) return fail(x2.failure);
      const y2 = requireNumber(element.attributes, "y2", bytes, context);
      if (y2.failure) return fail(y2.failure);
      try {
        entities.push(
          createLineEntity(
            id,
            toSketch(frame, x1.value ?? 0, y1.value ?? 0),
            toSketch(frame, x2.value ?? 0, y2.value ?? 0),
          ),
        );
      } catch {
        return fail(
          svgError(
            SVG_IMPORT_ERROR_CODES.invalidNumber,
            `${context} failed line conversion.`,
            bytes,
          ),
        );
      }
      continue;
    }

    if (element.tag === "circle") {
      const cx = requireNumber(element.attributes, "cx", bytes, context);
      if (cx.failure) return fail(cx.failure);
      const cy = requireNumber(element.attributes, "cy", bytes, context);
      if (cy.failure) return fail(cy.failure);
      const r = requireNumber(element.attributes, "r", bytes, context);
      if (r.failure) return fail(r.failure);
      try {
        entities.push(
          createCircleEntity(
            id,
            toSketch(frame, cx.value ?? 0, cy.value ?? 0),
            r.value ?? 0,
          ),
        );
      } catch {
        return fail(
          svgError(
            SVG_IMPORT_ERROR_CODES.invalidNumber,
            `${context} has a non-positive radius.`,
            bytes,
          ),
        );
      }
      continue;
    }

    if (element.tag === "ellipse") {
      const rx = numberAttribute(element.attributes, "rx") ?? null;
      const ry = numberAttribute(element.attributes, "ry") ?? null;
      if (rx === null || ry === null || rx <= 0 || ry <= 0) {
        declined.push({ kind: element.tag, reason: "element-out-of-subset" });
        continue;
      }
      if (rx !== ry) {
        declined.push({ kind: element.tag, reason: "element-out-of-subset" });
        continue;
      }
      const cx = requireNumber(element.attributes, "cx", bytes, context);
      if (cx.failure) return fail(cx.failure);
      const cy = requireNumber(element.attributes, "cy", bytes, context);
      if (cy.failure) return fail(cy.failure);
      try {
        entities.push(
          createCircleEntity(
            id,
            toSketch(frame, cx.value ?? 0, cy.value ?? 0),
            rx,
          ),
        );
      } catch {
        return fail(
          svgError(
            SVG_IMPORT_ERROR_CODES.invalidNumber,
            `${context} failed ellipse conversion.`,
            bytes,
          ),
        );
      }
      continue;
    }

    if (element.tag === "rect") {
      const x = requireNumber(element.attributes, "x", bytes, context);
      if (x.failure) return fail(x.failure);
      const y = requireNumber(element.attributes, "y", bytes, context);
      if (y.failure) return fail(y.failure);
      const width = requireNumber(element.attributes, "width", bytes, context);
      if (width.failure) return fail(width.failure);
      const height = requireNumber(
        element.attributes,
        "height",
        bytes,
        context,
      );
      if (height.failure) return fail(height.failure);
      const w = width.value ?? 0;
      const h = height.value ?? 0;
      if (w <= 0 || h <= 0) {
        return fail(
          svgError(
            SVG_IMPORT_ERROR_CODES.invalidNumber,
            `${context} has non-positive extent ${String(w)}×${String(h)}.`,
            bytes,
          ),
        );
      }
      const x0 = x.value ?? 0;
      const y0 = y.value ?? 0;
      const corners = [
        toSketch(frame, x0, y0),
        toSketch(frame, x0 + w, y0),
        toSketch(frame, x0 + w, y0 + h),
        toSketch(frame, x0, y0 + h),
      ];
      try {
        for (let i = 0; i < 4; i += 1) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          if (a === undefined || b === undefined) continue;
          entities.push(
            createLineEntity(
              i === 0 ? id : createSketchEntityId(`${id}-s${String(i)}`),
              a,
              b,
            ),
          );
        }
      } catch {
        return fail(
          svgError(
            SVG_IMPORT_ERROR_CODES.invalidNumber,
            `${context} failed rectangle conversion.`,
            bytes,
          ),
        );
      }
      continue;
    }

    if (element.tag === "path") {
      const data = element.attributes.get("d");
      if (data === undefined || data.trim().length === 0) {
        declined.push({ kind: element.tag, reason: "element-out-of-subset" });
        continue;
      }
      const outcome = convertPath(frame, id, data);
      if (outcome.tag === "invalid") {
        return fail(
          svgError(
            SVG_IMPORT_ERROR_CODES.invalidNumber,
            `${context}: ${outcome.message}.`,
            bytes,
          ),
        );
      }
      if (outcome.tag === "declined") {
        declined.push({ kind: element.tag, reason: outcome.reason });
        continue;
      }
      entities.push(...outcome.entities);
      continue;
    }

    declined.push({ kind: element.tag, reason: "element-out-of-subset" });
  }

  return ok({
    entities,
    units: "mm",
    viewBox:
      viewBoxRaw === undefined ? null : { x: frame.originX, y: frame.originY },
    declined,
  });
}
