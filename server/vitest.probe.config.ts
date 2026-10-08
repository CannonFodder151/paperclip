import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

export default mergeConfig(
  base,
  defineConfig({ test: { hookTimeout: 180_000, teardownTimeout: 60_000, testTimeout: 60_000 } }),
);
