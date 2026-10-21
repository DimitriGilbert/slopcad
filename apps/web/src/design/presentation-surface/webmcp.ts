/**
 * The WebMCP tool-name extractor.
 *
 * Tool names are a published contract: an agent (or the session e2e driving
 * `document.modelContext`) calls `cad_run_command` by that exact string. Every
 * tool in this app is authored through `defineWebMcpTool({ name: "…" })`, so
 * the name set is a static property of the source — extracted here rather
 * than by booting the app, which would need a browser and a mounted store.
 */

import ts from "typescript";

/** One tool's published identity. */
export interface WebMcpToolRecord {
  readonly name: string;
  /** Whether the tool declares `annotations.readOnlyHint`. */
  readonly readOnly: boolean;
}

const FACTORY = "defineWebMcpTool";

/** The string value of an object literal's `name` property. */
function nameOf(object: ts.ObjectLiteralExpression): string | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (!ts.isIdentifier(property.name) || property.name.text !== "name") {
      continue;
    }
    if (ts.isStringLiteralLike(property.initializer)) {
      return property.initializer.text;
    }
  }
  return null;
}

/** Whether `annotations: { readOnlyHint: true }` is declared. */
function declaresReadOnlyHint(object: ts.ObjectLiteralExpression): boolean {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    if (
      !ts.isIdentifier(property.name) ||
      property.name.text !== "annotations"
    ) {
      continue;
    }
    const { initializer } = property;
    if (!ts.isObjectLiteralExpression(initializer)) continue;
    for (const hint of initializer.properties) {
      if (!ts.isPropertyAssignment(hint)) continue;
      if (!ts.isIdentifier(hint.name) || hint.name.text !== "readOnlyHint") {
        continue;
      }
      if (hint.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
    }
  }
  return false;
}

/** Every WebMCP tool one source file defines, sorted by name. */
export function extractWebMcpTools(
  fileName: string,
  sourceText: string,
): readonly WebMcpToolRecord[] {
  const source = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const tools = new Map<string, WebMcpToolRecord>();

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === FACTORY
    ) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
        const name = nameOf(argument);
        if (name !== null) {
          tools.set(name, { name, readOnly: declaresReadOnlyHint(argument) });
        }
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
}
