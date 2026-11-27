import { defineConfig } from "vitest/config";

// Every discovered test is required; new tests need no manual registration.
export default defineConfig({ test: {
  include: ["*.test.ts", "*.test.tsx"],
  maxWorkers: 2,
} });
