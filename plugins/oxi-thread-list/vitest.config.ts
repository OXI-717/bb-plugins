import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({ resolve: { alias: { "@": fileURLToPath(new URL("./vendor/shared-ui", import.meta.url)) } }, test: { silent: "passed-only", include: ["**/*.test.{ts,tsx}"], exclude: ["node_modules/**"], maxWorkers: 2 } });
