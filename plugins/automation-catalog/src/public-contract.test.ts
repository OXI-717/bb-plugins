import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createFakePluginHost, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
it("uses only public packages and package-local imports", () => {
  const scan = experimental_scanPublicSdkOnly(fileURLToPath(new URL("..", import.meta.url)), { allow: [/^react-dom\/server$/, /^(react|vitest|better-sqlite3|cronstrue|class-variance-authority|clsx|tailwind-merge)$/, /^@radix-ui\/react-slot$/] });
  expect(scan.privateDependencies).toEqual([]);
  expect(scan.violations).toEqual([]);
});
it("loads and reloads using the official SDK without background jobs", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "automation-catalog" });
  let current = harness;
  try {
    plugin(bb);
    expect(await harness.behavior.callRpc("catalog_list", null)).toEqual({ tasks: [], sources: [] });
    current = (await harness.lifecycle.reload(plugin)).harness;
    expect(await current.behavior.callRpc("catalog_list", null)).toEqual({ tasks: [], sources: [] });
  } finally { await current.lifecycle.dispose(); }
});
