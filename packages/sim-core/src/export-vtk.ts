/**
 * The VTK `.vti` exporter (law S7): a field block exports as a ParaView-
 * readable XML ImageData document — the field's values as an ASCII
 * `DataArray` in `PointData`, the block's unit (when present) as
 * `FieldData` metadata, deterministic number formatting throughout so
 * identical blocks export to identical bytes. Geometry is document-space
 * millimetres (VTK is unitless; the FieldData unit states the axes').
 *
 * Phase 63c adds the DECIMATED twin ({@link exportSimFieldVtiDecimated}):
 * result field series can be large, so exports may decimate the node
 * lattice by an integer factor per axis — every factor-th node, spacing
 * scaled by the factor — with the factor stated honestly as `FieldData`
 * metadata (`decimation`, the `fx fx fx` form), never hidden in a
 * silently-thinned grid. Decimation happens ONLY here, at the export
 * door: persisted payloads and finalize bytes stay lossless (law S7).
 */

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { type SimResultFieldBlock } from "./sim-result";
import { formatSimFloat } from "./format";
import { type SimParseResult, simFail, simOk } from "./result";

/** How many values share one line in the ASCII data array (diff-friendly). */
const VALUES_PER_LINE = 6;

/** The largest decimation factor per axis an export may thin by. */
export const SIM_VTI_MAX_DECIMATION = 16;

/** Escapes a label for XML attribute output (ids/units are conservative already). */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Renders one `DataArray type="String"` FieldData entry. */
function stringFieldData(name: string, value: string): string {
  return `    <DataArray type="String" Name="${escapeXmlAttribute(name)}" NumberOfTuples="1" format="ascii">\n      ${escapeXmlAttribute(value)}\n    </DataArray>\n`;
}

/** The structural validation every render shares (extent, values, triples). */
function validateBlock(
  block: SimResultFieldBlock,
): SimParseResult<true, SimError> {
  const [nx, ny, nz] = block.extent;
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    !Number.isInteger(nz) ||
    (nx ?? 0) <= 0 ||
    (ny ?? 0) <= 0 ||
    (nz ?? 0) <= 0 ||
    block.values.length !== (nx ?? 1) * (ny ?? 1) * (nz ?? 1)
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.quantityInvalid,
        "A .vti export needs a field block whose extent is three positive integers matching its value count.",
        block,
      ),
    );
  }
  for (const value of block.values) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          `The field block "${block.id}" carries a non-finite value.`,
          value,
        ),
      );
    }
  }
  for (const triple of [block.originMm, block.spacingMm] as const) {
    if (
      triple.some(
        (entry) => typeof entry !== "number" || !Number.isFinite(entry),
      )
    ) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          `The field block "${block.id}" carries a malformed origin or spacing triple.`,
          triple,
        ),
      );
    }
  }
  return simOk(true);
}

/** Renders the validated block as the VTK document, with extra FieldData. */
function renderVti(
  block: SimResultFieldBlock,
  extraFieldData: readonly { readonly name: string; readonly value: string }[],
): string {
  const [nx, ny, nz] = block.extent;
  const extentText = `0 ${String((nx ?? 1) - 1)} 0 ${String((ny ?? 1) - 1)} 0 ${String((nz ?? 1) - 1)}`;
  const originText = block.originMm
    .map((entry) => formatSimFloat(entry))
    .join(" ");
  const spacingText = block.spacingMm
    .map((entry) => formatSimFloat(entry))
    .join(" ");
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of block.values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const lines: string[] = [];
  for (let start = 0; start < block.values.length; start += VALUES_PER_LINE) {
    const slice = block.values.slice(start, start + VALUES_PER_LINE);
    lines.push(slice.map((value) => formatSimFloat(value)).join(" "));
  }
  const id = escapeXmlAttribute(block.id);
  const fieldDataEntries: string[] = [];
  if (block.unit !== undefined) {
    fieldDataEntries.push(stringFieldData("unit", block.unit));
  }
  for (const entry of extraFieldData) {
    fieldDataEntries.push(stringFieldData(entry.name, entry.value));
  }
  const fieldData =
    fieldDataEntries.length === 0
      ? ""
      : `  <FieldData>\n${fieldDataEntries.join("")}  </FieldData>\n`;
  return (
    `<?xml version="1.0"?>\n` +
    `<VTKFile type="ImageData" version="0.1" byte_order="LittleEndian">\n` +
    `  <ImageData WholeExtent="${extentText}" Origin="${originText}" Spacing="${spacingText}">\n` +
    `    <Piece Extent="${extentText}">\n` +
    fieldData +
    `      <PointData Scalars="${id}">\n` +
    `        <DataArray type="${block.dataType === "float32" ? "Float32" : "Float64"}" Name="${id}" format="ascii" RangeMin="${formatSimFloat(min)}" RangeMax="${formatSimFloat(max)}">\n` +
    `${lines.map((line) => `          ${line}`).join("\n")}\n` +
    `        </DataArray>\n` +
    `      </PointData>\n` +
    `    </Piece>\n` +
    `  </ImageData>\n` +
    `</VTKFile>\n`
  );
}

/**
 * Exports one field block as a VTK XML ImageData (`.vti`) document.
 * Deterministic: the same block always produces the identical string —
 * fixed attribute order, the shared deterministic float formatter, six
 * values per line, LF endings, trailing newline.
 */
export function exportSimFieldVti(
  block: SimResultFieldBlock,
): SimParseResult<string, SimError> {
  const valid = validateBlock(block);
  if (!valid.ok) return valid;
  return simOk(renderVti(block, []));
}

/**
 * Decimates one field block's node lattice by an integer factor per axis:
 * every factor-th node stays (node indices 0, f, 2f, … per axis), spacing
 * scales by the factor (the samples stay node-centered), and the extent
 * becomes the surviving node count per axis. Deterministic and lossless
 * in the framing sense — the output is exactly the sub-lattice, never a
 * resample. Factor 1 returns the block's values unchanged (a fresh block,
 * not the input reference).
 */
export function decimateSimFieldBlock(
  block: SimResultFieldBlock,
  factor: number,
): SimParseResult<SimResultFieldBlock, SimError> {
  const valid = validateBlock(block);
  if (!valid.ok) return valid;
  if (
    !Number.isInteger(factor) ||
    factor < 1 ||
    factor > SIM_VTI_MAX_DECIMATION
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.quantityInvalid,
        `A .vti decimation factor must be an integer in [1, ${String(SIM_VTI_MAX_DECIMATION)}], received ${String(factor)}.`,
        factor,
      ),
    );
  }
  if (factor === 1) {
    return simOk({ ...block, values: [...block.values] });
  }
  const [nx, ny, nz] = block.extent;
  const count = (nodes: number): number =>
    Math.floor(((nodes ?? 1) - 1) / factor) + 1;
  const extent: readonly [number, number, number] = [
    count(nx ?? 1),
    count(ny ?? 1),
    count(nz ?? 1),
  ];
  const values: number[] = [];
  for (let k = 0; k < (extent[2] ?? 1); k += 1) {
    for (let j = 0; j < (extent[1] ?? 1); j += 1) {
      for (let i = 0; i < (extent[0] ?? 1); i += 1) {
        const index =
          i * factor +
          j * factor * (nx ?? 1) +
          k * factor * (nx ?? 1) * (ny ?? 1);
        values.push(block.values[index] ?? 0);
      }
    }
  }
  return simOk({
    ...block,
    extent,
    spacingMm: [
      (block.spacingMm[0] ?? 0) * factor,
      (block.spacingMm[1] ?? 0) * factor,
      (block.spacingMm[2] ?? 0) * factor,
    ],
    values,
  });
}

/**
 * Exports one field block as a decimated `.vti` document: the lattice
 * thinned by {@link decimateSimFieldBlock}, the factor stated as `FieldData`
 * `decimation` metadata (the `fx fx fx` form) so the file is honest about
 * what it carries. Deterministic; factor 1 is the full-fidelity export
 * with an explicit `1x1x1` marker.
 */
export function exportSimFieldVtiDecimated(
  block: SimResultFieldBlock,
  factor: number,
): SimParseResult<string, SimError> {
  const decimated = decimateSimFieldBlock(block, factor);
  if (!decimated.ok) return decimated;
  const marker = `${String(factor)}x${String(factor)}x${String(factor)}`;
  return simOk(
    renderVti(decimated.value, [{ name: "decimation", value: marker }]),
  );
}
