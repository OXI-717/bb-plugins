import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
describe("plugin lifecycle", () => {
  it("reloads without resetting storage or parent configuration", async () => {
    let host = createFakePluginHost({ pluginId: "automation-catalog", sdk: { threads: { get: async () => makeThreadResponse({ id: "parent", archivedAt: null }) } } });
    try {
      plugin(host.bb);
      await host.harness.behavior.setSettings({ parentThreadId: "parent" });
      host.bb.storage.database().exec("CREATE TABLE reload_sentinel (value TEXT); INSERT INTO reload_sentinel VALUES ('retained')");
      host = await host.harness.lifecycle.reload(plugin);
      const db = host.bb.storage.database();
      expect(db.prepare("SELECT count(*) AS count FROM catalog_migrations").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT value FROM reload_sentinel").get()).toEqual({ value: "retained" });
      expect(await host.harness.behavior.callRpc("catalog_compose_context", {})).toMatchObject({ parentThreadId: "parent" });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='automations'").get()).toBeUndefined();
    } finally { await host.harness.lifecycle.dispose(); }
  });
});
