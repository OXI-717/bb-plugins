import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { catalogMigration, createCatalog } from "./catalog.js";
import { refreshBbCatalog } from "./bb-refresh.js";

describe("BB refresh", () => {
  it("does not query the local CLI for an unbound BB source", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(catalogMigration);
      const catalog = createCatalog(db);
      catalog.publish({ source: { id: "bb-remote", name: "Remote", staleAfterMs: 60000, bbServerUrl: "http://127.0.0.1:38887" }, observedAt: 1, error: null, tasks: [], runs: [] }, "http://127.0.0.1:38886");
      await expect(refreshBbCatalog(catalog, async () => { throw new Error("called"); }, "http://127.0.0.1:38886"))
        .rejects.toThrow(/не подключён/);
    } finally { db.close(); }
  });
  it("reads the scheduler, updates a deleted task as missing, and preserves history", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(catalogMigration);
      const catalog = createCatalog(db);
      catalog.publish({ source: { id: "bb-local", name: "BB", staleAfterMs: 60000, bbServerUrl: "http://127.0.0.1:38886" }, observedAt: 1, error: null, tasks: [], runs: [] }, "http://127.0.0.1:38886");
      let entries = [{ project: { id: "proj_test", name: "Test" }, automation: {
        id: "auto_test", name: "Daily", enabled: true,
        execution: { mode: "script", interpreter: "python3" },
        trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      } }];
      const command = async (...args: string[]) => args[0] === "plugin"
        ? { automations: entries }
        : { runs: [{ id: "run1", status: "failed", startedAt: 100, finishedAt: 200, exitCode: 1, output: "PRIVATE" }] };
      await refreshBbCatalog(catalog, command, "http://127.0.0.1:38886");
      const task = catalog.list().tasks[0];
      expect(task.state).toBe("active");
      expect(task.missing).toBe(false);
      expect(catalog.detail({ key: task.key }).total).toBe(1);
      expect(JSON.stringify(catalog.detail({ key: task.key }))).not.toContain("PRIVATE");
      entries = [];
      await refreshBbCatalog(catalog, command, "http://127.0.0.1:38886");
      expect(catalog.list().tasks[0].missing).toBe(true);
      expect(catalog.detail({ key: task.key }).total).toBe(1);
      catalog.remove(task.key);
      expect(catalog.list().tasks).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
