import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    maxWorkers: process.env.CI ? 4 : 8,
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
