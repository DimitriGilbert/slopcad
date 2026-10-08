/**
 * The VTK `.vti` exporter (law S7): a field block exports as a ParaView-
 * readable XML ImageData document — the field's values as an ASCII
 * `DataArray` in `PointData`, the block's unit (when present) as
 * `FieldData` metadata, deterministic number formatting throughout so
 * identical blocks export to identical bytes. Geometry is document-space
 * millimetres (VTK is unitless; the FieldData unit states the axes').
 */

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { type SimResultFieldBlock } from "./sim-result";
import { formatSimFloat } from "./format";
import { type SimParseResult, simFail, simOk } from "./result";

/** How many values share one line in the ASCII data array (diff-friendly). */
const VALUES_PER_LINE = 6;

/** Escapes a label for XML attribute output (ids/units are conservative already). */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  const unitFieldData =
    block.unit === undefined
      ? ""
      : `  <FieldData>\n    <DataArray type="String" Name="unit" NumberOfTuples="1" format="ascii">\n      ${escapeXmlAttribute(block.unit)}\n    </DataArray>\n  </FieldData>\n`;
  return simOk(
    `<?xml version="1.0"?>\n` +
      `<VTKFile type="ImageData" version="0.1" byte_order="LittleEndian">\n` +
      `  <ImageData WholeExtent="${extentText}" Origin="${originText}" Spacing="${spacingText}">\n` +
      `    <Piece Extent="${extentText}">\n` +
      unitFieldData +
      `      <PointData Scalars="${id}">\n` +
      `        <DataArray type="${block.dataType === "float32" ? "Float32" : "Float64"}" Name="${id}" format="ascii" RangeMin="${formatSimFloat(min)}" RangeMax="${formatSimFloat(max)}">\n` +
      `${lines.map((line) => `          ${line}`).join("\n")}\n` +
      `        </DataArray>\n` +
      `      </PointData>\n` +
      `    </Piece>\n` +
      `  </ImageData>\n` +
      `</VTKFile>\n`,
  );
}
