import "vite-plus/test/config";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The validator tests bundle the CLI and run it in child processes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
