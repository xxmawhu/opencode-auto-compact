import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".var/**", "coverage/**", "tests/.tmp*/**"],
  },
  js.configs.recommended,
  {
    // Type-aware rules only apply to the TypeScript library sources.
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: process.cwd(),
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // The install/ entries are copied verbatim and carry no project references.
    files: ["install/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: false },
    },
  },
  {
    files: ["tests/**/*.mjs", "*.js"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        URL: "readonly",
        Buffer: "readonly",
      },
    },
  },
);
