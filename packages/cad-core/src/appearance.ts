/**
 * Appearances (Phase 59): the pure display data a body — or one synthetic
 * face of a body's topology snapshot — carries into every renderer: base
 * color, metalness, roughness, and an optional named procedural texture.
 *
 * ## Display records, not model data
 *
 * An appearance changes NO geometry, feature, or parameter — the exact
 * class the Phase 44 display flags established. Records ride the body
 * record additively and an old reader's tolerant body parse drops them
 * (display state only degrades, never model data), which is why the
 * native envelope stays at its current version.
 *
 * ## The library
 *
 * {@link APPEARANCE_LIBRARY} is the named-preset table ("named presets as
 * data"): fixed records the authoring surface copies INTO a body's
 * record. The library is an authoring aid only — a record is
 * self-contained values, never a reference, so documents never depend on
 * the table's contents staying put.
 *
 * ## Textures are procedural and named
 *
 * The only texture a record may name is a member of
 * {@link APPEARANCE_TEXTURES}: deterministic, code-generated patterns the
 * renderer builds from state alone (no image assets, no IO, nothing
 * clock- or environment-derived), so a textured appearance rasterizes
 * byte-identically under the fixed-viewport/DPR discipline. There is
 * deliberately no free-form texture reference: an imported image asset
 * would drag nondeterministic bytes into the deterministic scene
 * contract, and that is a structured refusal (`appearance/texture-unknown`),
 * not a degraded render.
 */

import { type ParseResult, fail, ok } from "./result";

/** One appearance record: pure material display data. */
export interface Appearance {
  /** Opaque sRGB hex (`#rrggbb`). */
  readonly baseColor: string;
  /** 0 (dielectric) to 1 (metal). */
  readonly metalness: number;
  /** 0 (mirror-smooth) to 1 (fully rough). */
  readonly roughness: number;
  /** Named procedural texture; absent = untextured. */
  readonly texture?: AppearanceTextureName;
}

/** The procedural texture names a record may carry (see the module doc). */
export const APPEARANCE_TEXTURES = ["checker"] as const;

export type AppearanceTextureName = (typeof APPEARANCE_TEXTURES)[number];

/** Stable failure codes for appearance validation. */
export const APPEARANCE_ERROR_CODES = {
  malformed: "appearance/malformed",
  colorInvalid: "appearance/color-invalid",
  scalarOutOfRange: "appearance/scalar-out-of-range",
  textureUnknown: "appearance/texture-unknown",
} as const;

/** The `code` union of {@link APPEARANCE_ERROR_CODES}. */
export type AppearanceErrorCode =
  (typeof APPEARANCE_ERROR_CODES)[keyof typeof APPEARANCE_ERROR_CODES];

interface AppearanceFailure {
  readonly code: AppearanceErrorCode;
  readonly message: string;
  readonly input: unknown;
}

function appearanceError(
  code: AppearanceErrorCode,
  message: string,
  input: unknown,
): AppearanceFailure {
  return { code, message, input };
}

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

/** Validates one scalar against the 0..1 unit range. */
function validateUnitScalar(
  value: number,
  label: string,
  input: unknown,
): AppearanceFailure | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return appearanceError(
      APPEARANCE_ERROR_CODES.malformed,
      `The appearance ${label} must be a finite number.`,
      input,
    );
  }
  if (value < 0 || value > 1) {
    return appearanceError(
      APPEARANCE_ERROR_CODES.scalarOutOfRange,
      `The appearance ${label} must be between 0 and 1 (got ${String(value)}).`,
      input,
    );
  }
  return null;
}

/**
 * Validates untrusted input as an {@link Appearance}: a hex base color,
 * unit-range metalness/roughness, and — when present — a known procedural
 * texture name. Total: every field is checked, nothing is smuggled.
 */
export function parseAppearance(input: unknown): ParseResult<Appearance> {
  if (typeof input !== "object" || input === null) {
    return fail(
      appearanceError(
        APPEARANCE_ERROR_CODES.malformed,
        "An appearance must be a record with baseColor, metalness, and roughness.",
        input,
      ),
    );
  }
  const record = input as Record<string, unknown>;
  const baseColor = record.baseColor;
  if (typeof baseColor !== "string" || !HEX_COLOR_PATTERN.test(baseColor)) {
    return fail(
      appearanceError(
        APPEARANCE_ERROR_CODES.colorInvalid,
        'The appearance baseColor must be an "#rrggbb" hex string.',
        input,
      ),
    );
  }
  const metalness = record.metalness;
  if (typeof metalness !== "number") {
    return fail(
      appearanceError(
        APPEARANCE_ERROR_CODES.malformed,
        "The appearance metalness must be a number.",
        input,
      ),
    );
  }
  const metalnessFailure = validateUnitScalar(metalness, "metalness", input);
  if (metalnessFailure !== null) return fail(metalnessFailure);
  const roughness = record.roughness;
  if (typeof roughness !== "number") {
    return fail(
      appearanceError(
        APPEARANCE_ERROR_CODES.malformed,
        "The appearance roughness must be a number.",
        input,
      ),
    );
  }
  const roughnessFailure = validateUnitScalar(roughness, "roughness", input);
  if (roughnessFailure !== null) return fail(roughnessFailure);
  let texture: AppearanceTextureName | undefined;
  const rawTexture = record.texture;
  if (rawTexture !== undefined) {
    if (
      typeof rawTexture !== "string" ||
      !APPEARANCE_TEXTURES.includes(rawTexture as AppearanceTextureName)
    ) {
      return fail(
        appearanceError(
          APPEARANCE_ERROR_CODES.textureUnknown,
          `The appearance texture must be one of ${APPEARANCE_TEXTURES.map((entry) => `"${entry}"`).join(", ")} — free-form texture assets are refused, not degraded.`,
          input,
        ),
      );
    }
    texture = rawTexture as AppearanceTextureName;
  }
  return ok(
    Object.freeze({
      baseColor,
      metalness,
      roughness,
      ...(texture === undefined ? {} : { texture }),
    }),
  );
}

/** Canonical JSON form of an appearance (fixed key order, texture only when present). */
export function serializeAppearance(appearance: Appearance): {
  readonly baseColor: string;
  readonly metalness: number;
  readonly roughness: number;
  readonly texture?: AppearanceTextureName;
} {
  return {
    baseColor: appearance.baseColor,
    metalness: appearance.metalness,
    roughness: appearance.roughness,
    ...(appearance.texture === undefined
      ? {}
      : { texture: appearance.texture }),
  };
}

/** True when two appearance records carry identical values. */
export function appearancesEqual(
  a: Appearance | undefined,
  b: Appearance | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return (
    a.baseColor === b.baseColor &&
    a.metalness === b.metalness &&
    a.roughness === b.roughness &&
    a.texture === b.texture
  );
}

/**
 * A library entry: the preset's stable id (the authoring surface's handle)
 * and its appearance record.
 */
export interface AppearanceLibraryEntry {
  readonly id: string;
  readonly label: string;
  readonly appearance: Appearance;
}

/**
 * The appearance library (Phase 59): named presets as DATA. Authoring
 * copies a preset's VALUES into a body record — the table never becomes a
 * document dependency (see the module doc).
 */
export const APPEARANCE_LIBRARY: readonly AppearanceLibraryEntry[] =
  Object.freeze([
    {
      id: "steel",
      label: "Machined steel",
      appearance: Object.freeze({
        baseColor: "#aabdd6",
        metalness: 0.85,
        roughness: 0.35,
      }),
    },
    {
      id: "brass",
      label: "Brass",
      appearance: Object.freeze({
        baseColor: "#c8a24a",
        metalness: 0.9,
        roughness: 0.3,
      }),
    },
    {
      id: "copper",
      label: "Copper",
      appearance: Object.freeze({
        baseColor: "#b87352",
        metalness: 0.9,
        roughness: 0.35,
      }),
    },
    {
      id: "anodized-blue",
      label: "Anodized blue",
      appearance: Object.freeze({
        baseColor: "#3b6fb4",
        metalness: 0.6,
        roughness: 0.5,
      }),
    },
    {
      id: "carbon",
      label: "Carbon (checker)",
      appearance: Object.freeze({
        baseColor: "#2a2d33",
        metalness: 0.2,
        roughness: 0.6,
        texture: "checker",
      }),
    },
    {
      id: "ceramic",
      label: "Ceramic white",
      appearance: Object.freeze({
        baseColor: "#e8e6df",
        metalness: 0,
        roughness: 0.25,
      }),
    },
  ]);

/** Reads one library entry by id, or `undefined`. */
export function appearanceLibraryEntry(
  id: string,
): AppearanceLibraryEntry | undefined {
  return APPEARANCE_LIBRARY.find((entry) => entry.id === id);
}

/**
 * One face-level appearance override (Phase 59): an appearance record
 * scoped to ONE synthetic face of the body's topology snapshot (the
 * deterministic triangle-grouping the picking and highlight machinery
 * already resolve — the "topology snapshot mapping" the roadmap names).
 * The face index is SNAPSHOT-SCOPED: a regeneration that reorders or
 * removes faces leaves the override addressing a face that no longer
 * exists, and every consumer must then SKIP it (render nothing for it) —
 * never remap it onto an arbitrary neighbor.
 */
export interface FaceAppearanceOverride {
  /** The synthetic face index in the owning body's topology snapshot. */
  readonly face: number;
  readonly appearance: Appearance;
}

/** How many face-level overrides one body record may carry (the edit budget). */
export const BODY_FACE_APPEARANCE_LIMIT = 64;

/** True when the override's face index is inside the given face count. */
export function faceOverrideInSnapshot(
  override: FaceAppearanceOverride,
  faceCount: number,
): boolean {
  return (
    Number.isInteger(override.face) &&
    override.face >= 0 &&
    override.face < faceCount
  );
}
