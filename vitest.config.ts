import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // No test reaches a service, a credential or the network, so `npm test` is
    // green on a clean checkout with nothing configured. This variable keeps it
    // that way on a machine that *is* configured: without it the config module
    // reads the developer's `.env`, and a suite that behaves differently
    // depending on whose machine it runs on is not the zero-configuration suite
    // this repository claims to have.
    env: { DEMO_SKIP_DOTENV: "1" },
  },
});
