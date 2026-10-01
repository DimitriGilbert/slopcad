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
The stored `value` is the cached evaluation, and the command vocabulary
keeps the cache honest: `parameter.set` carries an optional expression
payload (a serialized AST, never source text — parse at the edge with
`parseExpression`), in three strictly discriminated forms:

- **value only** — the raw cached-value write the vocabulary always had.
  Nothing is recomputed, and any stored expression stays in place (this is
  what lets pre-expression logs replay byte-identically).
- **`expression: null`** (with the `value` it lands on) — the parameter
  stops being expression-driven and becomes that literal.
- **an AST** (with no `value`) — the parameter becomes expression-driven
  through it. The single `applyCommand` interpreter validates every
  identifier against the document's parameters (an unknown name is refused
  by name, `parameter/unknown-identifier`), refuses a closing cycle with
  the chain (`parameter/cycle`), stores the AST, and recomputes every
  expression-driven parameter in topological order in the SAME
  application. So an edit to `holeDiameter` committed as an expression
  re-drives `volumeHint` and everything downstream of it before the commit
  returns.

`parameter.create` takes the same optional AST beside its required initial
value. A dependent whose evaluation fails keeps its prior cached value
(warning-level: the commit succeeds, nothing is fabricated, and the next
successful commit of the failing dependency re-drives it). The recompute
covers every expression-driven parameter, not only the edited one's
dependents, so a commit deterministically heals pre-existing staleness.

The runnable example below shows the pre-vocabulary version of that move:
the `holeDiameter` edit commits as a value-only set (no recompute) and the
expression is re-evaluated by hand — `evaluateExpression` over the fresh
`parameterEnvironment` — to take `volumeHint` 20 → 25. The vocabulary path
for the same move is one expression-payload commit, whose `parameter.set`
wire line is
`{"formatVersion":1,"type":"parameter.set","id":"param_hole","expression":{"kind":"unitLiteral","value":12.5,"unit":"mm"}}`
— `volumeHint` is re-derived inside that single application, no manual
pass.

The React surfaces commit the same payloads: the parameter panel's
expression field and `useCadParameters().setValueFromExpression` parse
text and ship the AST; the `cad_set_parameter` WebMCP tool does the same
for string inputs (numbers stay literal value writes).

## The runnable example

`packages/docs-examples/src/core/document.ts` (the `volumeHint` chain)
and `src/core/units.ts` (the `0.5in` literal evaluated to 12.7 mm).
