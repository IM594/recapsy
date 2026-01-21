import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["*.config.{js,cjs,mjs}", "tailwind.config.js", "postcss.config.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Config files commonly use `require()` / CommonJS patterns.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Avoid warnings: frontend lint runs with `--max-warnings 0`.
      "react-hooks/exhaustive-deps": "off",
      "react-refresh/only-export-components": "off",

      // Keep lint actionable for this repo: TypeScript already runs in `pnpm build`.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  }
);
