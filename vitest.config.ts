import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts", "apps/*/e2e/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
