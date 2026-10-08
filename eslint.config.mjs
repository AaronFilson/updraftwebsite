// ESLint flat config. Rules catch likely bugs; formatting is left to Prettier (.prettierrc.json).
import js from "@eslint/js";
import globals from "globals";

const bugRules = {
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
  "no-var": "error",
  "prefer-const": "error",
};

export default [
  {
    ignores: [
      "dist/",
      ".cache/",
      "backend/.build/",
      "backend/.build-images/",
      "**/node_modules/",
      "playwright-report/",
      "test-results/",
      ".lighthouseci/",
    ],
  },
  // Browser code, bundled by esbuild (scripts/build.mjs defines __SITE_CONFIG__).
  {
    files: ["site/js/**/*.js", "site/p.js"],
    ...js.configs.recommended,
    languageOptions: { sourceType: "module", globals: { ...globals.browser, __SITE_CONFIG__: "readonly" } },
    rules: { ...js.configs.recommended.rules, ...bugRules },
  },
  // Node: Lambda handler, build/deploy scripts and all tests.
  {
    files: ["**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: { sourceType: "module", globals: { ...globals.node } },
    rules: { ...js.configs.recommended.rules, ...bugRules },
  },
  // Site unit tests run in Node against the browser modules.
  {
    files: ["site/js/test/**/*.mjs", "e2e/**/*.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
