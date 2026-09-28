// ESLint checks only the rules of React hooks; types are tsc's job (pnpm typecheck).
// The React Compiler rules that eslint-plugin-react-hooks 6+ adds to its presets are not enabled.
// An exhaustive-deps finding whose fix would change when an effect runs is left with
// "// eslint-disable-next-line react-hooks/exhaustive-deps -- <why>".
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["dist/**", "src-tauri/**", "node_modules/**", "src/api/schema.d.ts"] },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
