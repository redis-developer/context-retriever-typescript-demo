import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Tests that need a live deployment opt in explicitly and skip loudly
    // otherwise, so `npm test` is green on a clean checkout.
    environment: "node",
  },
});
