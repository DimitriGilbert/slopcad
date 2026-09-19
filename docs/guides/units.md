# Units

Everything in slopcad is dimensionally typed. A `DimensionalValue` pairs
a magnitude with a unit and a dimension (`length`, `angle`, `area`,
`volume`, `dimensionless`); the type system keeps the dimension, the
runtime keeps the unit. Canonical units are **millimetre, radian, mm²,
mm³** — every boundary (kernels, IO, worker protocol) speaks canonical,
authors may write what they like.

## Building and reading values

```ts
import {
  length,
  angle,
  area,
  volume,
  dimensionless,
  valueIn,
  convert,
  toCanonical,
} from "@slopcad/cad-core";

const plateWidth = length(2, "in"); // { dimension: "length", unit: "in", value: 2 }
valueIn(plateWidth, "mm"); // 50.8 (25.4 per inch)
valueIn(angle(1, "deg"), "rad"); // π/180
toCanonical(length(1, "in")); // { unit: "mm", value: 25.4 }
```

`LENGTH_UNITS`, `ANGLE_UNITS`, `AREA_UNITS`, `VOLUME_UNITS` list the
accepted tokens; `parseUnit` and `isUnitToken` gate untrusted input.
Constructors and converters throw `DimensionalValueValidationError` on
non-finite magnitudes or a unit of the wrong dimension — these are
programmer errors, not parse failures.

## The wire and string forms

The serialized form is the `{dimension, unit, value}` record:

```ts
parseDimensionalValue({ dimension: "length", unit: "in", value: 0.5 });
// → LengthValue; valueIn(result.value, "mm") === 12.7
serializeDimensionalValue(parsed.value); // canonical triple: { dimension: "length", unit: "mm", value: 12.7 }
```

The author-facing string form is the expression engine's unit literals —
`parseExpression("0.5in")` then `evaluateExpression` (see
[expressions.md](expressions.md)). There is deliberately no separate
"12.5 mm" string parser outside expressions.

## Dimensioned arithmetic

The arithmetic is typed: `multiply(length, length)` is an `AreaValue`,
`multiply(area, length)` a `VolumeValue`, `divide(length, length)` a
`DimensionlessValue` — operands convert to canonical units first, so an
inch-wide plate multiplies directly against millimetre depths:

```ts
multiply(multiply(length(2, "in"), length(40)), length(5));
// VolumeValue: 10160 mm³  (= 50.8 × 40 × 5)
valueIn(convert(volume(10160), "in3"), "in3"); // ≈ 0.620
```

`add`/`subtract` require the same dimension; `addValues` /
`multiplyValues` / `divideValues` are the dynamic-path `ParseResult`
variants for untyped operands.

## The runnable example

`packages/docs-examples/src/core/units.ts` computes exactly these facts;
the suite pins `inchInMm: 25.4`, the degree ratio, the parsed records,
the 10160 mm³ box, and the inch³ conversion.
