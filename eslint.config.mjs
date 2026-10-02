import js from "@eslint/js";
import importPlugin from "eslint-plugin-import";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.output/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/reports/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/e2e-artifacts/**",
      "**/routeTree.gen.ts",
      "**/*.gen.ts",
      // The standalone viewer's COMPILED bundle (vite.standalone.config's
      // output lands in the app's public directory so the site serves it
      // like any asset) — build output, not source.
      "**/public/viewer-standalone/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      import: importPlugin,
      "react-hooks": reactHooks,
    },
    rules: {
      "import/order": [
        "error",
        {
          groups: [
            ["builtin", "external", "object", "type"],
            ["parent", "sibling", "index"],
          ],
          "newlines-between": "always",
        },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
      "@typescript-eslint/only-throw-error": ["error", { allow: ["Redirect"] }],
    },
  },
  {
    // apps/web is the only package with enough files to trip the TypeScript 6
    // tsserver document-registry crash (updateOpen → isDocumentRegistryEntry,
    // microsoft/TypeScript #62369/#62451) that projectService drives through
    // its updateOpen cycle. Classic project mode builds the program directly
    // and never touches that layer; every apps/web ts/tsx is in its tsconfig.
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["./apps/web/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: [
      "apps/web/**/*.{ts,tsx}",
      "packages/ui/**/*.{ts,tsx}",
      "packages/cad-r3f/**/*.{ts,tsx}",
      "packages/cad-react/**/*.{ts,tsx}",
      // The viewer composition: the one React file in cad-components (the
      // package's component model itself stays React-free).
      "packages/cad-components/src/viewer/**",
    ],
    rules: reactHooks.configs.recommended.rules,
  },
  {
    // Vendored owned-source from the Formedible registry: full recommended
    // rules, imports, formatting and typecheck apply — but not the
    // type-aware ruleset written for our own code (upstream internals
    // intentionally template ReactNode unions and carry `any` seams).
    files: ["packages/ui/src/components/formedible/**"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["**/scripts/**/*.mjs", "**/*.config.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      // These are Node-run scripts; without a TS project the parser has no
      // environment to source Node globals from.
      globals: {
        URL: "readonly",
        console: "readonly",
        process: "readonly",
      },
    },
  },
);
