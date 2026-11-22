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
      expect(db.prepare("SELECT count(*) AS count FROM catalog_migrations").get()).toEqual({ count: 3 });
      expect(db.prepare("SELECT value FROM reload_sentinel").get()).toEqual({ value: "retained" });
      expect(await host.harness.behavior.callRpc("catalog_compose_context", {})).toMatchObject({ parentThreadId: "parent" });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='automations'").get()).toBeUndefined();
      expect(await host.harness.behavior.callRpc("catalog_audit_list", { key })).toMatchObject({ total: 1, records: [{ summary: "Checked inputs", presentInCatalog: true }] });
    } finally { await host.harness.lifecycle.dispose(); }
  });
  it("migrates a legacy v1/v2 runs table without evidence/sort_at columns and prunes overflow runs", async () => {
    const host = createFakePluginHost({ pluginId: "automation-catalog" });
    try {
      const db = host.bb.storage.database();
      db.exec(`
        CREATE TABLE catalog_migrations (version INTEGER PRIMARY KEY);
        INSERT INTO catalog_migrations VALUES (1), (2);
        CREATE TABLE automation_catalog_sources (id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE automation_catalog_tasks (key TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES automation_catalog_sources(id), missing INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
        CREATE INDEX automation_catalog_tasks_source ON automation_catalog_tasks(source_id);
        CREATE TABLE automation_catalog_runs (task_key TEXT NOT NULL REFERENCES automation_catalog_tasks(key), id TEXT NOT NULL, started_at INTEGER, data TEXT NOT NULL, PRIMARY KEY(task_key, id));
        CREATE INDEX automation_catalog_runs_time ON automation_catalog_runs(task_key, started_at DESC, id);
        CREATE TABLE automation_catalog_audits (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, task_key TEXT NOT NULL, idempotency_key TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(task_key, idempotency_key));
      `);
      const source = { id: "legacy-src", name: "Legacy", staleAfterMs: 60000, checkedAt: 5000, lastSuccessAt: 5000, error: null };
      const task = {
        id: "watch", name: "Watch", host: "worker-example", scope: "personal", owner: null, team: null,
        projectId: null, scheduler: "launchd", executor: "script", schedule: "Every 60 seconds",
        state: "active", description: "", history: "available", url: null,
        key: "ext_legacy_task_key", sourceId: "legacy-src", observedAt: 5000, missing: false, review: null,
      };
      db.prepare("INSERT INTO automation_catalog_sources VALUES (?, ?, ?)").run("legacy-src", 5000, JSON.stringify(source));
      db.prepare("INSERT INTO automation_catalog_tasks VALUES (?, ?, 0, ?)").run(task.key, "legacy-src", JSON.stringify(task));
      const insertRun = db.prepare("INSERT INTO automation_catalog_runs (task_key, id, started_at, data) VALUES (?, ?, ?, ?)");
      insertRun.run(task.key, "exec-old", 100, JSON.stringify({
        taskId: "watch", evidence: "execution", observedAt: 100, host: "worker-example", id: "exec-old",
        status: "succeeded", startedAt: 100, finishedAt: 110, summary: "ok", exitCode: 0,
      }));
      for (let i = 0; i < 520; i++) {
        insertRun.run(task.key, `state-${String(i).padStart(4, "0")}`, null, JSON.stringify({
          taskId: "watch", evidence: "state-change", observedAt: 1000 + i, host: "worker-example", id: `state-${String(i).padStart(4, "0")}`,
          status: "unknown", startedAt: null, finishedAt: null, summary: null, exitCode: null,
        }));
      }
      plugin(host.bb);
      expect(db.prepare("SELECT count(*) AS count FROM catalog_migrations").get()).toEqual({ count: 3 });
      const list = await host.harness.behavior.callRpc("catalog_list", undefined) as { tasks: Array<{ key: string; lastRun: { id: string } | null }> };
      expect(list.tasks[0]?.lastRun?.id).toBe("exec-old");
      const detail = await host.harness.behavior.callRpc("catalog_detail", { key: task.key, offset: 0, limit: 25 }) as { total: number; runs: Array<{ id: string }> };
      expect(detail.total).toBe(501); // 500 newest state-changes + preserved latest execution
      expect(detail.runs[0]?.id).toBe("state-0519");
    } finally { await host.harness.lifecycle.dispose(); }
  });
});
