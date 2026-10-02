import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@voxobs/schema": r("../../packages/schema/src/index.ts"),
      "@voxobs/sdk": r("../../packages/sdk/src/index.ts"),
    },
  },
  test: {
    fileParallelism: false,
  },
});
