import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { catalogMigration, createCatalog } from "./catalog.js";
import { refreshBbCatalog } from "./bb-refresh.js";

describe("BB refresh", () => {
  it("refreshes model settings and clears them on an agent-to-script transition", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(catalogMigration);
      const catalog = createCatalog(db);
      const url = "http://127.0.0.1:38886";
      catalog.publish({ source: { id: "bb-local", name: "BB", staleAfterMs: 60000, bbServerUrl: url }, observedAt: 1, error: null, tasks: [], runs: [] }, url);
      let execution: Record<string, unknown> = { mode: "agent", environment: { hostId: "host-example" }, providerId: "example", model: "model-one", reasoningLevel: "high", serviceTier: "fast", prompt: "PRIVATE" };
      const command = async (...args: string[]) => args[0] === "host" ? [{ id: "host-example", name: "Example Mac" }] : args[0] === "thread" ? { environment: { hostId: "host-example" } } : args[0] === "plugin" ? { automations: [{ project: { id: "project-example", name: "Example" }, automation: { id: "job", name: "Job", enabled: true, execution, trigger: { triggerType: "schedule", cron: "0 9 * * 0", timezone: "UTC" } } }] } : { runs: [] };
      await refreshBbCatalog(catalog, command, url);
      expect(catalog.list().tasks[0].agent).toEqual({ targetThreadId: null, provider: "example", model: "model-one", reasoning: "high", serviceTier: "fast", modelSource: "automation" });
      expect(catalog.list().tasks[0].host).toBe("Example Mac");
      execution = { ...execution, environment: undefined, model: "model-two", targetThreadId: "thread-example" };
      await refreshBbCatalog(catalog, command, url);
      expect(catalog.list().tasks.find(t => !t.missing)?.agent).toMatchObject({ model: "model-two", modelSource: "existing-thread" });
      expect(catalog.list().tasks.find(t => !t.missing)?.host).toBe("Example Mac");
      expect(JSON.stringify(catalog.list())).not.toContain("PRIVATE");
      await refreshBbCatalog(catalog, async (...args) => {
        if (args[0] === "thread") throw new Error("Target unavailable");
        if (args[0] === "host") expect(args).toEqual(["host", "list", "--all"]);
        return command(...args);
      }, url);
      expect(catalog.list().tasks.find(t => !t.missing)?.host).toBe("Хост не определён");
      await refreshBbCatalog(catalog, async (...args) => {
        if (args[0] === "host") throw new Error("Hosts unavailable");
        return command(...args);
      }, url);
      expect(catalog.list().tasks.find(t => !t.missing)?.host).toBe("Хост не определён");
      execution = { mode: "script", interpreter: "bash" };
      await refreshBbCatalog(catalog, command, url);
      expect(catalog.list().tasks.find(t => !t.missing)?.agent).toBeNull();
    } finally { db.close(); }
  });
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
      const command = async (...args: string[]) => args[0] === "host" ? [{ id: "host-example", name: "Example Mac" }] : args[0] === "thread" ? { environment: { hostId: "host-example" } } : args[0] === "plugin"
        ? { automations: entries }
        : { runs: [{ id: "run1", status: "failed", startedAt: 100, finishedAt: 200, exitCode: 1, output: "PRIVATE" }] };
      await refreshBbCatalog(catalog, command, "http://127.0.0.1:38886");
      const task = catalog.list().tasks[0];
      expect(task.state).toBe("active");
      expect(task.missing).toBe(false);
      expect(catalog.detail({ key: task.key }).total).toBe(1);
      expect(catalog.detail({ key: task.key }).runs[0].hasOutput).toBe(true);
      expect(JSON.stringify(catalog.detail({ key: task.key }))).not.toContain("PRIVATE");
      const { key, sourceId, observedAt, missing, lastRun, review, ...definition } = task;
      catalog.publish({ source: { id: "bb-local", name: "BB", staleAfterMs: 60000, bbServerUrl: "http://127.0.0.1:38886" }, observedAt: Date.now(), error: null, tasks: [{ ...definition, hostLabel: "team-worker" }], runs: [] }, "http://127.0.0.1:38886");
      await refreshBbCatalog(catalog, command, "http://127.0.0.1:38886");
      expect(catalog.list().tasks[0]).toMatchObject({ key, hostLabel: "team-worker", host: task.host });
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
