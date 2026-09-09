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
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
);
