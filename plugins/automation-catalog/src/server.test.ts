import { describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { catalogMigration, createCatalog } from "./catalog";
describe("plugin lifecycle", () => {
  it("upgrades an existing catalog without losing its projection", async () => {
    const host = createFakePluginHost({ pluginId: "automation-catalog" });
    try {
      const db = host.bb.storage.database();
      db.exec("CREATE TABLE catalog_migrations (version INTEGER PRIMARY KEY); INSERT INTO catalog_migrations VALUES (1)");
      db.exec(catalogMigration);
      const catalog = createCatalog(db);
      catalog.publish({ source: { id: "existing", name: "Existing", staleAfterMs: 60000 }, observedAt: 1, error: null, tasks: [], runs: [] });
      plugin(host.bb);
      expect(catalog.list().sources[0].id).toBe("existing");
      expect(await host.harness.behavior.callRpc("catalog_audit_list", {})).toEqual({ records: [], total: 0 });
    } finally { await host.harness.lifecycle.dispose(); }
  });
  it("reloads without resetting storage or parent configuration", async () => {
    let host = createFakePluginHost({ pluginId: "automation-catalog", sdk: { threads: { get: async () => makeThreadResponse({ id: "parent", archivedAt: null }) } } });
    try {
      plugin(host.bb);
      await host.harness.behavior.setSettings({ parentThreadId: "parent" });
      host.bb.storage.database().exec("CREATE TABLE reload_sentinel (value TEXT); INSERT INTO reload_sentinel VALUES ('retained')");
      await host.harness.behavior.callRpc("catalog_publish", {
        source: { id: "test", name: "Test", staleAfterMs: 60000 }, observedAt: 1, error: null,
        tasks: [{ id: "daily", name: "Daily", host: "example", scope: "personal", owner: null, team: null,
          projectId: null, scheduler: "cron", executor: "script", schedule: null, state: "active", description: "", history: "available", url: null }], runs: [],
      });
      const inventory = await host.harness.behavior.callRpc("catalog_list", undefined) as { tasks: { key: string }[] };
      const key = inventory.tasks[0].key;
      await host.harness.behavior.callRpc("catalog_audit_append", { key, idempotencyKey: "reload", outcome: "partial", decision: "keep", summary: "Checked inputs", checks: "Static inspection only" });
      host = await host.harness.lifecycle.reload(plugin);
      const db = host.bb.storage.database();
      expect(db.prepare("SELECT count(*) AS count FROM catalog_migrations").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT value FROM reload_sentinel").get()).toEqual({ value: "retained" });
      expect(await host.harness.behavior.callRpc("catalog_compose_context", {})).toMatchObject({ parentThreadId: "parent" });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='automations'").get()).toBeUndefined();
      expect(await host.harness.behavior.callRpc("catalog_audit_list", { key })).toMatchObject({ total: 1, records: [{ summary: "Checked inputs", presentInCatalog: true }] });
    } finally { await host.harness.lifecycle.dispose(); }
  });
});
