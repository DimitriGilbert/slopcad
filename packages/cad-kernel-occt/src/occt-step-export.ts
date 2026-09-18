/**
 * STEP file export at the OpenCascade boundary (Phase 21.4): owned BREP
 * shapes → one STEP Part 21 file, through `STEPControl_Writer` over the
 * emscripten virtual filesystem. The kernel layer (`./occt-kernel`) resolves
 * its kernel-neutral solid handles into shapes; everything OCCT-specific
 * about STEP *writing* lives here.
 *
 * ## Application protocol (observed against the binding, cited in the header)
 *
 * Every shape transfers under `STEPControl_AsIs` — "translates a shape to its
 * highest possible STEP representation", which for solids is the advanced
 * BREP chain the emitted file actually carries (observed: one
 * `MANIFOLD_SOLID_BREP` per solid inside an `ADVANCED_BREP_SHAPE_REPRESENTATION`
 * per product). That is the appropriate model type for BREP exchange: the
 * alternatives the writer offers (`FacetedBrep`, `ShellBasedSurfaceModel`,
 * `GeometricCurveSet`) each LOSE structure this kernel's solids have.
 *
 * The schema (the FILE_SCHEMA application protocol) defaults to the binding's
 * own default `write.step.schema = AP214IS` — the emitted header reads
 * `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'))`, i.e. AP214
 * (probed; that is also the committed 21.3 fixture's header). AP214 is the
 * appropriate default for mechanical BREP exchange — the broadly
 * interoperable schema OCCT itself ships as its default — and the exporter
 * can select `AP203` (`CONFIG_CONTROL_DESIGN` header) or `AP242DIS` instead
 * through {@link StepExportOptions.schema}. The selectable set is exactly the
 * set the binding's `Interface_Static` accepts (probed: those three tokens
 * switch the FILE_SCHEMA line; anything else is refused by `SetCVal`).
 *
 * ## Determinism (what the writer emits, and what this module neutralizes)
 *
 * The writer's output is deterministic in ALL GEOMETRY — probed across two
 * processes on the same machine: the plate-with-hole written twice in
 * independent processes produced 19,027 identical bytes except at exactly two
 * SITES, both pure bookkeeping text:
 *
 * 1. the `FILE_NAME` header timestamp (`'2026-09-17T06:59:11'` — the writer's
 *    local wall clock), and
 * 2. the PRODUCT name counter (`Open CASCADE STEP translator 8.0 1`,
 *    `… 2`, …) — a PROCESS-GLOBAL counter that increments for every product
 *    any writer in the process mints (probed: two fresh writers in one
 *    process produced counters 1 then 2), so the same solids exported twice
 *    in one runtime carry different names.
 *
 * This module neutralizes exactly those two sites by deterministic text
 * post-processing — the timestamp is replaced with the fixed
 * {@link STEP_EXPORT_EPOCH_STAMP} and every product-name counter is renumbered
 * `1..k` in order of first appearance (preserving the writer's per-file
 * uniqueness) — and NOTHING else: no coordinate, entity number, entity order,
 * or geometry byte is touched (STEP Part 21 is ASCII, so the edit is
 * text-exact). If the header's `FILE_NAME` timestamp is not where these
 * probes found it, the export refuses with
 * {@link STEP_EXPORT_ERROR_CODES.nondeterministic} rather than emit bytes
 * whose determinism it cannot vouch for. Same solids in, same bytes out,
 * every call and every runtime — pinned across fresh worker runtimes by the
 * tests.
 *
 * ## Units (the canonicalization stance)
 *
 * The kernel's canonical unit is the millimetre, and the default
 * (`write.step.unit = MM`) writes coordinates unchanged in mm. Selecting
 * another {@link StepExportUnit} does NOT rescale the model in any
 * kernel-side way: the binding's writer converts the coordinates into the
 * selected unit and declares it in the file (probed: INCH emits
 * `CONVERSION_BASED_UNIT('INCH',…)`), and OCCT readers — this package's
 * importer included, verified by its INCH fixture test — canonicalize back
 * to mm on import. Unit selection is therefore a file-unit declaration for
 * downstream consumers, not a change of the kernel's geometry.
 *
 * `write.step.unit`/`write.step.schema` are PROCESS-GLOBAL `Interface_Static`
 * state, so an export that overrides either restores the value it found
 * (read after writer construction, when the binding registers the STEP
 * parameter table — probed) in a `finally`: options never leak into later
 * exports or the reader's canonicalization.
 *
 * ## Binding stdout (documented, not a hazard)
 *
 * The writer prints a transfer-statistics block ("Statistics on Transfer
 * (Write) … As Is … ents) Write Done") to the console through OCCT's internal
 * message printer; the classes for muting printers are not bound in this
 * build. The noise is the binding's documented stdout — worker code neither
 * depends on it nor suppresses it (same stance as the 21.3 reader).
 */

import {
  type ParseFailure,
  type ParseResult,
  fail,
  ok,
} from "@slopcad/cad-core";
import type { OpenCascadeInstance, TopoDS_Shape } from "replicad-opencascadejs";

/** Stable failure codes produced when STEP export rejects its input. */
export const STEP_EXPORT_ERROR_CODES = {
  /** Zero solids — there is no geometry to export. */
  empty: "step-export/empty",
  /** A unit the binding's writer does not accept (probed set documented above). */
  invalidUnit: "step-export/invalid-unit",
  /** A schema token the binding's writer does not accept. */
  invalidSchema: "step-export/invalid-schema",
  /** A shape the writer refused to translate to STEP (`Transfer` not Done). */
  transferFailed: "step-export/transfer-failed",
  /** The writer could not write the transferred model (`Write` not Done). */
  writeFailed: "step-export/write-failed",
  /**
   * The emitted header did not carry the FILE_NAME timestamp these probes
   * pin, so the module cannot neutralize it — refusing beats emitting bytes
   * whose determinism is unverified.
   */
  nondeterministic: "step-export/nondeterministic",
  /** The binding threw inside the export boundary. */
  kernelFailure: "step-export/kernel-failure",
} as const;

export type StepExportErrorCode =
  (typeof STEP_EXPORT_ERROR_CODES)[keyof typeof STEP_EXPORT_ERROR_CODES];

/** Structured failure describing why STEP export rejected its input. */
export interface StepExportError extends ParseFailure {
  readonly code: StepExportErrorCode;
}

/**
 * The length units the binding's writer accepts for `write.step.unit`
 * (probed: each token is accepted by `SetCVal`, and INCH observably changes
 * the file's declared length unit). `MM` is the default and the kernel's
 * canonical unit.
 */
export const STEP_EXPORT_UNITS = [
  "MM",
  "CM",
  "M",
  "KM",
  "INCH",
  "FT",
  "MI",
  "MIL",
  "UM",
  "UIN",
] as const;

/** A selectable `write.step.unit` value; default and canonical: `MM`. */
export type StepExportUnit = (typeof STEP_EXPORT_UNITS)[number];

/**
 * The schema tokens the binding's writer accepts for `write.step.schema`
 * (probed: each switches the FILE_SCHEMA line; anything else is refused).
 * `AP214IS` is the binding's default — the appropriate AP for mechanical
 * BREP exchange here.
 */
export const STEP_EXPORT_SCHEMAS = ["AP214IS", "AP203", "AP242DIS"] as const;

/** A selectable `write.step.unit`-adjacent schema token; default `AP214IS`. */
export type StepExportSchema = (typeof STEP_EXPORT_SCHEMAS)[number];

/** Type guard for {@link StepExportUnit} over untrusted wire strings. */
function isStepExportUnit(input: unknown): input is StepExportUnit {
  return (
    typeof input === "string" &&
    (STEP_EXPORT_UNITS as readonly string[]).includes(input)
  );
}

/** Type guard for {@link StepExportSchema} over untrusted wire strings. */
function isStepExportSchema(input: unknown): input is StepExportSchema {
  return (
    typeof input === "string" &&
    (STEP_EXPORT_SCHEMAS as readonly string[]).includes(input)
  );
}

/** Options of {@link exportStepShapes}; every field keeps the binding default. */
export interface StepExportOptions {
  /**
   * The file's declared length unit (default `MM`). The writer converts the
   * kernel's canonical millimetre coordinates into it — see the module doc's
   * unit stance.
   */
  readonly unit?: StepExportUnit;
  /**
   * The FILE_SCHEMA application protocol (default `AP214IS`, the binding's
   * own default — see the module doc's protocol section).
   */
  readonly schema?: StepExportSchema;
}

/**
 * Narrows untrusted unit/schema strings (the worker wire carries plain
 * strings; which values are accepted is this kernel's semantic call) into
 * the typed {@link StepExportOptions}, rejecting anything the binding's
 * writer would refuse with the structured `step-export/invalid-*` codes.
 */
export function parseStepExportOptions(
  settings: Readonly<StepExportSettingsInput>,
): ParseResult<StepExportOptions, StepExportError> {
  const { unit, schema } = settings;
  if (unit !== undefined && !isStepExportUnit(unit)) {
    return fail(
      stepError(
        STEP_EXPORT_ERROR_CODES.invalidUnit,
        `The export rejected unit "${unit}"; the binding's writer accepts ${STEP_EXPORT_UNITS.join(", ")}.`,
      ),
    );
  }
  if (schema !== undefined && !isStepExportSchema(schema)) {
    return fail(
      stepError(
        STEP_EXPORT_ERROR_CODES.invalidSchema,
        `The export rejected schema "${schema}"; the binding's writer accepts ${STEP_EXPORT_SCHEMAS.join(", ")}.`,
      ),
    );
  }
  return ok({
    ...(unit === undefined ? {} : { unit }),
    ...(schema === undefined ? {} : { schema }),
  });
}

/**
 * The unvalidated stringly settings form a carrier layer (e.g. the worker
 * wire) hands an exporter: unit/schema as optional plain strings.
 */
export interface StepExportSettingsInput {
  readonly unit?: string;
  readonly schema?: string;
}

/**
 * The fixed timestamp written into the neutralized FILE_NAME header: the Unix
 * epoch in the writer's own local-time ISO-8601 shape. A constant, never a
 * clock — the determinism contract.
 */
export const STEP_EXPORT_EPOCH_STAMP = "1970-01-01T00:00:00";

/** MEMFS path counter: unique per export, deterministic per context. */
let memfsPathCounter = 0;

function stepError(
  code: StepExportErrorCode,
  message: string,
): StepExportError {
  return { code, message, input: null };
}

/** Escapes a literal for embedding in a `RegExp`. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The FILE_NAME statement's timestamp site: the second string parameter of
 * `FILE_NAME('…','<ISO-8601 local time>',…`. Anchored on the statement
 * keyword and the first quoted parameter, so it cannot match geometry data.
 */
const FILE_NAME_TIMESTAMP_PATTERN =
  /(FILE_NAME\('[^']*',')\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(')/;

/**
 * Neutralizes the writer's two nondeterministic sites in the decoded Part 21
 * text (see the module doc): the FILE_NAME wall-clock timestamp becomes the
 * fixed epoch stamp, and every occurrence of the writer's product-name
 * counter (`<product name> <n>`, a process-global sequence) is renumbered
 * `1..k` in order of first appearance. Returns `undefined` when the header
 * does not carry the pinned FILE_NAME timestamp shape — the caller refuses.
 */
function neutralizeNondeterminism(
  text: string,
  productBaseName: string,
): string | undefined {
  if (!FILE_NAME_TIMESTAMP_PATTERN.test(text)) {
    return undefined;
  }
  const stamped = text.replace(
    FILE_NAME_TIMESTAMP_PATTERN,
    `$1${STEP_EXPORT_EPOCH_STAMP}$2`,
  );
  const counters = new Map<string, number>();
  const counterPattern = new RegExp(
    `${escapeRegExp(productBaseName)} (\\d+)`,
    "g",
  );
  return stamped.replace(counterPattern, (_whole: string, digits: string) => {
    let assigned = counters.get(digits);
    if (assigned === undefined) {
      assigned = counters.size + 1;
      counters.set(digits, assigned);
    }
    return `${productBaseName} ${String(assigned)}`;
  });
}

/**
 * The static-parameter restore record: what `write.step.unit` and
 * `write.step.schema` read before an export overrode them, so the override
 * never leaks past the export (the table is process-global).
 */
interface StaticRestore {
  readonly unit: string;
  readonly schema: string;
}

/**
 * Exports `shapes` — one or more owned BREP shapes — into ONE deterministic
 * STEP Part 21 file (`Transfer` per shape, one `Write`), returning its bytes.
 * Total: any input either exports or fails with a structured
 * `step-export/*` code — never a throw. The virtual file the writer emits is
 * unlinked on every path, and overridden static parameters are restored.
 */
export function exportStepShapes(
  oc: OpenCascadeInstance,
  shapes: readonly TopoDS_Shape[],
  options: Readonly<StepExportSettingsInput> = {},
): ParseResult<Uint8Array, StepExportError> {
  if (shapes.length === 0) {
    return fail(
      stepError(
        STEP_EXPORT_ERROR_CODES.empty,
        "The export received zero solids; there is no geometry to export.",
      ),
    );
  }
  // Runtime re-validation of the stringly fields (compile-time callers hold
  // the typed union; wire-side callers were narrowed by the host) — the
  // binding's own SetCVal booleans are checked again below.
  const validated = parseStepExportOptions(options);
  if (!validated.ok) return fail(validated.error);

  const memfsPath = `/slopcad-step-export-${(memfsPathCounter += 1)}.step`;
  let writer: InstanceType<typeof oc.STEPControl_Writer> | undefined;
  try {
    writer = new oc.STEPControl_Writer();
    // Construction registers the binding's STEP parameter table (probed), so
    // the capture reads the real defaults — and the product-name pattern the
    // neutralizer must renumber is the binding's own current value.
    const restore: StaticRestore = {
      unit: oc.Interface_Static.CVal("write.step.unit"),
      schema: oc.Interface_Static.CVal("write.step.schema"),
    };
    const productBaseName = oc.Interface_Static.CVal("write.step.product.name");
    try {
      if (
        validated.value.unit !== undefined &&
        !oc.Interface_Static.SetCVal("write.step.unit", validated.value.unit)
      ) {
        return fail(
          stepError(
            STEP_EXPORT_ERROR_CODES.invalidUnit,
            `The binding's writer refused unit "${validated.value.unit}".`,
          ),
        );
      }
      if (
        validated.value.schema !== undefined &&
        !oc.Interface_Static.SetCVal(
          "write.step.schema",
          validated.value.schema,
        )
      ) {
        return fail(
          stepError(
            STEP_EXPORT_ERROR_CODES.invalidSchema,
            `The binding's writer refused schema "${validated.value.schema}".`,
          ),
        );
      }
      for (const shape of shapes) {
        const progress = new oc.Message_ProgressRange();
        try {
          const transfer = writer.Transfer(
            shape,
            oc.STEPControl_StepModelType.STEPControl_AsIs,
            true,
            progress,
          );
          if (transfer !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
            return fail(
              stepError(
                STEP_EXPORT_ERROR_CODES.transferFailed,
                `The OCCT STEP writer refused to translate a shape (status ${String(transfer)}).`,
              ),
            );
          }
        } finally {
          progress.delete();
        }
      }
      if (
        writer.Write(memfsPath) !== oc.IFSelect_ReturnStatus.IFSelect_RetDone
      ) {
        return fail(
          stepError(
            STEP_EXPORT_ERROR_CODES.writeFailed,
            "The OCCT STEP writer could not write the transferred model.",
          ),
        );
      }
      const raw = oc.FS.readFile(memfsPath);
      if (productBaseName === "") {
        return fail(
          stepError(
            STEP_EXPORT_ERROR_CODES.nondeterministic,
            "The binding exposed no product-name parameter, so the writer's product counters cannot be neutralized.",
          ),
        );
      }
      const text = new TextDecoder().decode(raw);
      const neutral = neutralizeNondeterminism(text, productBaseName);
      if (neutral === undefined) {
        return fail(
          stepError(
            STEP_EXPORT_ERROR_CODES.nondeterministic,
            "The written STEP header did not carry the pinned FILE_NAME timestamp, so the export cannot guarantee deterministic bytes.",
          ),
        );
      }
      return ok(new TextEncoder().encode(neutral));
    } finally {
      // Static parameters are process-global: whatever this export overrode
      // returns to the value it found, on every path.
      oc.Interface_Static.SetCVal("write.step.unit", restore.unit);
      oc.Interface_Static.SetCVal("write.step.schema", restore.schema);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(
      stepError(
        STEP_EXPORT_ERROR_CODES.kernelFailure,
        `STEP export failed inside the OpenCascade boundary: ${detail}`,
      ),
    );
  } finally {
    writer?.delete();
    try {
      oc.FS.unlink(memfsPath);
    } catch {
      // The write itself failed, or OCCT removed the path — nothing to
      // clean; the export's own outcome stands.
    }
  }
}
