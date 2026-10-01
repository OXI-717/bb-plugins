import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "app.test.tsx", "account-policy-form.test.tsx"], maxWorkers: 2 } });
