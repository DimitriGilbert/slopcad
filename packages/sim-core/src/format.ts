/**
 * Deterministic number formatting for the exporters: identical values
 * always render to identical text, so identical results export to
 * identical bytes. The formatter pins a fixed significant-digit budget
 * and a single canonical spelling per value (lowercase exponent marker,
 * no trailing zeros in the mantissa, integers rendered bare) — the
 * byte-determinism rule the native format established for persisted
 * documents, applied to exported ones.
 */

/** The default significant-digit budget for exported quantities. */
export const SIM_EXPORT_SIGNIFICANT_DIGITS = 6;

/**
 * Formats a finite number deterministically: up to
 * {@link SIM_EXPORT_SIGNIFICANT_DIGITS} significant digits via
 * `toPrecision`, mantissa trailing zeros trimmed (never the exponent's
 * digits), canonical exponent spelling (bare, sign only when negative).
 * Non-finite input is the caller's validation failure, never a rendered
 * "NaN".
 */
export function formatSimFloat(
  value: number,
  significantDigits: number = SIM_EXPORT_SIGNIFICANT_DIGITS,
): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `formatSimFloat needs a finite number, received ${String(value)}.`,
    );
  }
  if (value === 0) return "0";
  const text = value.toPrecision(significantDigits);
  const trimMantissa = (mantissa: string): string =>
    mantissa.includes(".")
      ? mantissa.replace(/0+$/, "").replace(/\.$/, "")
      : mantissa;
  if (!text.includes("e")) {
    return trimMantissa(text);
  }
  const separator = text.indexOf("e");
  const mantissa = text.slice(0, separator);
  const exponent = text.slice(separator + 1);
  return `${trimMantissa(mantissa)}e${String(Number(exponent))}`;
}
