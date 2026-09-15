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
    files: ["apps/web/**/*.{ts,tsx}", "packages/ui/**/*.{ts,tsx}"],
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
    files: ["scripts/**/*.mjs", "**/*.config.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
