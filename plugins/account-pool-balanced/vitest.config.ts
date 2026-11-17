import { defineConfig } from "vitest/config";

// Every discovered test is required; new root/UI tests need no manual registration.
export default defineConfig({ test: {
  include: ["src/**/*.test.ts", "src/**/*.test.tsx", "*.test.ts", "*.test.tsx"],
  maxWorkers: 2,
} });
