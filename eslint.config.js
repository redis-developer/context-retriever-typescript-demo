// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/**", "dist/**", ".local/**", "src/agent/web/**"] },
  eslint.configs.recommended,
  // Type-aware linting is the whole point of choosing typescript-eslint over a
  // faster linter: `no-floating-promises` needs type information, and this
  // codebase is almost entirely async around a `close()` the SDK documents as
  // able to throw. An unawaited promise is the likeliest bug here.
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Reading env vars as process.env["NAME"] is required by
      // noPropertyAccessFromIndexSignature, which we enable to match the SDK's
      // own compiler options so its snippets paste in unchanged.
      "@typescript-eslint/dot-notation": "off",
      // The CLI is a console application; console output is the interface.
      "no-console": "off",
    },
  },
  {
    // Config files are plain JS outside the tsconfig project, so type-aware
    // rules have no type information for them.
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    // The comparison's fairness invariant, enforced rather than documented.
    //
    // Both arms of `npm run compare` must differ only in their tools. An arm
    // that could reach the model provider or the configuration could pick a
    // different model, a different reasoning effort or a different step
    // budget, and the comparison would quietly stop being a comparison. The
    // `Arm` interface has no member for any of them; this is what stops an arm
    // going around it. Everything an arm legitimately needs is handed to it
    // through `ArmContext`.
    files: ["src/compare/arms/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@ai-sdk/openai",
              message:
                "An arm may not choose a model. Model calls go through ArmContext.askModel, which uses the model both arms are measured on.",
            },
            {
              name: "../../config/env.ts",
              message:
                "An arm may not read configuration. Everything it needs is passed in, so the two arms cannot be configured differently.",
            },
          ],
          patterns: [
            {
              group: ["**/agent/turn.ts"],
              message:
                "An arm may not run a turn. runTurn owns the model and the step budget for both arms; the runner calls it once per question.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
