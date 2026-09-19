# Expressions

The expression engine gives parameters formulas: `holeDiameter * 2`,
`min(width, 30mm)`, `sqrt(2) * pitch`. It lives in three cad-core
modules: the AST (`expression.ts`), the parser (`expression-parser.ts`),
and the evaluator (`expression-evaluator.ts`).

## The language

- Numbers are decimals without exponent notation.
- Unit literals attach to numbers: `30mm`, `0.5in`, `90deg` (`2.5in`
  parses; `2.5 in` does not — no space between magnitude and unit).
- Binary operators: `+ - * / % ^` (`BINARY_OPERATORS`).
- Functions: `sqrt`, `min`, `max` (`EXPRESSION_FUNCTIONS`), with checked
  arity.
- Identifiers resolve through a caller-supplied environment — in a
  document, the other parameters by name.

## The pipeline

```ts
import {
  parseExpression,
  evaluateExpression,
  parameterEnvironment,
  extractExpressionDependencies,
  printExpression,
} from "@slopcad/cad-core";

const parsed = parseExpression("holeDiameter * 2"); // ExpressionNode (AST)
if (!parsed.ok) throw new Error(parsed.error.message);
const value = evaluateExpression(
  parsed.value,
  parameterEnvironment(doc.parameters),
);
if (!value.ok) throw new Error(value.error.message);
value.value; // the dimensional result (a length: 25 mm for holeDiameter 12.5)
```

`parseExpression` fails structured (`expression/<cause>` codes: depth
ceiling `MAX_EXPRESSION_DEPTH`, identifier length, unknown tokens).
`evaluateExpression` fails on unknown identifiers, arity mismatch, and
dimension misuse — `2mm + 3deg` is a structured rejection, not a number.
`extractExpressionDependencies` lists the identifiers an AST reads (the
parameter graph's edge source); `printExpression` renders an AST back to
canonical text.

## Where expressions live

A parameter may carry one (`addDocumentParameter`'s `expression` field).
The stored `value` is the cached evaluation at commit time; edits to
referenced parameters re-drive it through the same evaluator — the
document example asserts `volumeHint` moving 20 → 25 when `holeDiameter`
moves 10 → 12.5.

## The runnable example

`packages/docs-examples/src/core/document.ts` (the `volumeHint` chain)
and `src/core/units.ts` (the `0.5in` literal evaluated to 12.7 mm).
