/**
 * The route extractor.
 *
 * TanStack Router already resolves the file-route convention for us and
 * writes the answer into `src/routeTree.gen.ts`: the `FileRoutesByPath`
 * module augmentation lists every route's `id`, `path`, `fullPath` and the
 * route module it loads. Re-deriving routes from directory names would be a
 * second, divergent implementation of that convention — so this module reads
 * the generated file instead, as data, through the TypeScript parser.
 *
 * The generated file is never edited here; it is only ever read.
 */

import ts from "typescript";

/** One route as the generated route tree declares it. */
export interface RouteRecord {
  /** The router's route id, e.g. `/_auth/projects/`. */
  readonly id: string;
  /** The segment path this route contributes, e.g. `/projects`. */
  readonly path: string;
  /** The resolved URL path, e.g. `/projects/$projectId`. */
  readonly fullPath: string;
  /** The route module, relative to the app's `src` directory. */
  readonly module: string;
}

const AUGMENTED_INTERFACE = "FileRoutesByPath";

/** The string value of a property whose initializer/type is a literal. */
function literalMemberValue(
  member: ts.TypeElement,
  name: string,
): string | null {
  if (!ts.isPropertySignature(member)) return null;
  if (!ts.isIdentifier(member.name) || member.name.text !== name) return null;
  const { type } = member;
  if (type === undefined || !ts.isLiteralTypeNode(type)) return null;
  return ts.isStringLiteral(type.literal) ? type.literal.text : null;
}

/** The identifier a `preLoaderRoute: typeof XImport` member points at. */
function preLoaderIdentifier(member: ts.TypeElement): string | null {
  if (!ts.isPropertySignature(member)) return null;
  if (!ts.isIdentifier(member.name)) return null;
  if (member.name.text !== "preLoaderRoute") return null;
  const { type } = member;
  if (type === undefined || !ts.isTypeQueryNode(type)) return null;
  return ts.isIdentifier(type.exprName) ? type.exprName.text : null;
}

/** Map every `import { Route as X } from "./routes/y"` binding to its module. */
function importedModules(source: ts.SourceFile): ReadonlyMap<string, string> {
  const modules = new Map<string, string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      modules.set(element.name.text, specifier.replace(/^\.\//, ""));
    }
  }
  return modules;
}

/**
 * Every route declared by a generated TanStack route tree, sorted by id.
 *
 * @param sourceText the contents of `routeTree.gen.ts`
 */
export function extractRoutes(sourceText: string): readonly RouteRecord[] {
  const source = ts.createSourceFile(
    "routeTree.gen.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const modules = importedModules(source);
  const routes: RouteRecord[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isInterfaceDeclaration(node) &&
      node.name.text === AUGMENTED_INTERFACE
    ) {
      for (const member of node.members) {
        if (!ts.isPropertySignature(member)) continue;
        if (!ts.isStringLiteral(member.name)) continue;
        const { type } = member;
        if (type === undefined || !ts.isTypeLiteralNode(type)) continue;
        const id = member.name.text;
        const path =
          type.members
            .map((inner) => literalMemberValue(inner, "path"))
            .find((value) => value !== null) ?? "";
        const fullPath =
          type.members
            .map((inner) => literalMemberValue(inner, "fullPath"))
            .find((value) => value !== null) ?? "";
        const binding = type.members
          .map((inner) => preLoaderIdentifier(inner))
          .find((value) => value !== null);
        routes.push({
          id,
          path,
          fullPath,
          module:
            (binding === undefined ? undefined : modules.get(binding)) ?? "",
        });
      }
    }
    node.forEachChild(visit);
  };
  visit(source);

  return routes.sort((a, b) => a.id.localeCompare(b.id));
}
