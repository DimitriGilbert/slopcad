/**
 * The presentation-surface attribute extractor.
 *
 * The redesign may repaint every pixel of this app, but it may not silently
 * move the handles automation grabs: `aria-*`/`role` (assistive + Playwright
 * role queries), `data-testid` (the e2e fleet's selectors) and the `data-*`
 * STATE attributes components publish so tests can assert behaviour without
 * reading pixels. This module turns one TS/TSX source file into the set of
 * such handles it declares.
 *
 * Three declaration sites count:
 *
 *   1. JSX attributes — `<button aria-label="Undo" data-testid="undo" />`.
 *   2. Imperative DOM writes — `root.setAttribute("data-settled", "3")`,
 *      which several fixture pages use to publish worker counters.
 *   3. TESTID-BEARING PROPS — a prop or object property whose name ends in
 *      `testid` (`testId`, `triggerTestId`), which a descriptor-driven
 *      primitive forwards verbatim onto its own `data-testid`. The cockpit's
 *      `ToolFlyout` renders a tool family from a typed item list, so the
 *      family members' testids are declared there rather than as JSX
 *      attributes; without this site a verb folded into a flyout would
 *      silently vanish from the surface inventory while still being
 *      published to the DOM — exactly the drift this manifest exists to
 *      catch.
 *
 * Values are harvested statically where that is honest: string/boolean/
 * numeric literals, and the literal branches of a conditional or a logical
 * fallback (`data-state={open ? "open" : "closed"}` publishes BOTH states).
 * Anything computed — a call, a template literal, a variable — marks the
 * attribute `dynamic` rather than inventing a value. The parse is the
 * TypeScript compiler's own, never a regex, so JSX spreads, comments and
 * type assertions cannot produce phantom handles.
 */

import ts from "typescript";

/** Where a handle is declared: in JSX, or through an imperative DOM write. */
export type SurfaceOrigin = "jsx" | "setAttribute";

/** One attribute's declared handle within a single source file. */
export interface SurfaceAttributeOccurrence {
  /** The attribute name, lowercased: `aria-label`, `data-testid`, `role`. */
  readonly attribute: string;
  readonly origin: SurfaceOrigin;
  /** Statically known values, unsorted and possibly empty. */
  readonly values: readonly string[];
  /** True when at least one value is computed at runtime. */
  readonly dynamic: boolean;
}

/** `aria-*`, `data-*` and `role` are the surface; everything else is style. */
const SURFACE_ATTRIBUTE = /^(?:aria-[a-z][a-z-]*|data-[a-z][a-z0-9-]*|role)$/;

/**
 * A prop/property name that carries a testid a primitive forwards onto its
 * own `data-testid` (`testId`, `triggerTestId`, `faceTestId`, …). Matched
 * case-insensitively on the suffix so the naming stays the TS convention.
 */
const TESTID_BEARING_NAME = /testid$/;

/** The attribute a testid-bearing prop ultimately declares. */
const TESTID_ATTRIBUTE = "data-testid";

/** The DOM methods that DECLARE an attribute (reads are not a surface). */
const WRITER_METHODS = new Set([
  "setAttribute",
  "removeAttribute",
  "toggleAttribute",
]);

/** `a ?? b` and `a || b` yield either side; `a && b` only ever yields `b`. */
const VALUE_BEARING_LOGICAL = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
]);

interface HarvestedValues {
  readonly values: readonly string[];
  readonly dynamic: boolean;
}

const DYNAMIC: HarvestedValues = { values: [], dynamic: true };

function merge(...parts: readonly HarvestedValues[]): HarvestedValues {
  return {
    values: parts.flatMap((part) => part.values),
    dynamic: parts.some((part) => part.dynamic),
  };
}

/**
 * The statically knowable values of a value expression. Deliberately shallow:
 * it descends only through wrappers (parens, assertions) and value-selecting
 * operators (ternary, `??`, `||`), so a string literal buried in a call
 * argument is never mistaken for a published state.
 */
function harvestValues(node: ts.Expression): HarvestedValues {
  if (ts.isStringLiteralLike(node)) {
    // Template literals with substitutions are `isStringLiteralLike` only in
    // their no-substitution form, so `.text` here is the whole value.
    return { values: [node.text], dynamic: false };
  }
  if (ts.isNumericLiteral(node)) {
    return { values: [node.text], dynamic: false };
  }
  if (
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return { values: [node.getText()], dynamic: false };
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return harvestValues(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return merge(harvestValues(node.whenTrue), harvestValues(node.whenFalse));
  }
  if (ts.isBinaryExpression(node)) {
    if (VALUE_BEARING_LOGICAL.has(node.operatorToken.kind)) {
      return merge(harvestValues(node.left), harvestValues(node.right));
    }
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return harvestValues(node.right);
    }
  }
  return DYNAMIC;
}

/** The values a JSX attribute's initializer publishes. */
function harvestJsxInitializer(
  initializer: ts.JsxAttribute["initializer"],
): HarvestedValues {
  if (initializer === undefined) {
    // Boolean shorthand: `<div data-open />` renders the string "true".
    return { values: ["true"], dynamic: false };
  }
  if (ts.isStringLiteral(initializer)) {
    return { values: [initializer.text], dynamic: false };
  }
  if (!ts.isJsxExpression(initializer)) {
    // An element-valued attribute (`attr={<X />}` is parsed as an expression;
    // the remaining union members are JSX elements) publishes no string.
    return DYNAMIC;
  }
  const inner = initializer.expression;
  return inner === undefined ? DYNAMIC : harvestValues(inner);
}

/** The attribute name of a JSX attribute, or null when it is not a handle. */
function surfaceAttributeName(name: ts.JsxAttributeName): string | null {
  const text = ts.isJsxNamespacedName(name)
    ? `${name.namespace.text}:${name.name.text}`
    : name.text;
  const lowered = text.toLowerCase();
  if (SURFACE_ATTRIBUTE.test(lowered)) return lowered;
  return TESTID_BEARING_NAME.test(lowered) ? TESTID_ATTRIBUTE : null;
}

/**
 * The attribute an object-literal property declares — only testid-bearing
 * names count here. A descriptor's `label` or `description` is prose the
 * component chooses how to render; its `testId` is a handle, verbatim.
 */
function propertyTestIdName(name: ts.PropertyName): string | null {
  if (!ts.isIdentifier(name) && !ts.isStringLiteralLike(name)) return null;
  return TESTID_BEARING_NAME.test(name.text.toLowerCase())
    ? TESTID_ATTRIBUTE
    : null;
}

/** The attribute name a `setAttribute`-family call targets, or null. */
function writerAttributeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (!WRITER_METHODS.has(callee.name.text)) return null;
  const [first] = call.arguments;
  if (first === undefined || !ts.isStringLiteralLike(first)) return null;
  const lowered = first.text.toLowerCase();
  return SURFACE_ATTRIBUTE.test(lowered) ? lowered : null;
}

/**
 * Every presentation handle declared by one source file, deduplicated per
 * `attribute` + `origin` pair with its literal values unioned and sorted.
 */
export function extractSurfaceAttributes(
  fileName: string,
  sourceText: string,
): readonly SurfaceAttributeOccurrence[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const byKey = new Map<string, { values: Set<string>; dynamic: boolean }>();
  const record = (
    attribute: string,
    origin: SurfaceOrigin,
    harvested: HarvestedValues,
  ): void => {
    const key = `${origin}\u0000${attribute}`;
    const existing = byKey.get(key) ?? {
      values: new Set<string>(),
      dynamic: false,
    };
    for (const value of harvested.values) existing.values.add(value);
    byKey.set(key, {
      values: existing.values,
      dynamic: existing.dynamic || harvested.dynamic,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const attribute = surfaceAttributeName(node.name);
      if (attribute !== null) {
        record(attribute, "jsx", harvestJsxInitializer(node.initializer));
      }
    } else if (ts.isPropertyAssignment(node)) {
      const attribute = propertyTestIdName(node.name);
      if (attribute !== null) {
        record(attribute, "jsx", harvestValues(node.initializer));
      }
    } else if (ts.isCallExpression(node)) {
      const attribute = writerAttributeName(node);
      if (attribute !== null) {
        const [, value] = node.arguments;
        record(
          attribute,
          "setAttribute",
          value === undefined
            ? { values: [], dynamic: false }
            : harvestValues(value),
        );
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  return [...byKey]
    .map(([key, entry]) => {
      const [origin, attribute] = key.split("\u0000");
      return {
        attribute: attribute ?? "",
        origin: origin === "setAttribute" ? "setAttribute" : "jsx",
        values: [...entry.values].sort(),
        dynamic: entry.dynamic,
      } satisfies SurfaceAttributeOccurrence;
    })
    .sort(
      (a, b) =>
        a.attribute.localeCompare(b.attribute) ||
        a.origin.localeCompare(b.origin),
    );
}
