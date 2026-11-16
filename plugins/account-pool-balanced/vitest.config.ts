import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["src/**/*.test.ts", "app.test.tsx", "management-ui.test.tsx", "account-policy-form.test.tsx", "account-projects-form.test.tsx", "account-email-form.test.tsx", "account-proxy-form.test.tsx"], maxWorkers: 2 } });
