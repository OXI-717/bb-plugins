import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { catalogMigration, createCatalog } from "./catalog.js";
import { manageBbCatalog } from "./bb-management.js";

describe("BB management projection", () => {
  it("removes the catalog row only after BB confirms deletion", async () => {
    const db = new Database(":memory:");
    try {
      db.exec(catalogMigration);
      const catalog = createCatalog(db);
      catalog.publish({
        source: { id: "bb-main", name: "BB", staleAfterMs: 60000 }, observedAt: 1, error: null,
        tasks: [{ id: "auto_test", name: "Daily", host: "bb-host", scope: "personal", owner: null, team: null,
          projectId: "proj_test", scheduler: "bb", executor: "script", schedule: "0 9 * * *",
          state: "active", description: "Test", history: "available", url: null }],
        runs: [{ taskId: "auto_test", host: "bb-host", id: "run1", status: "succeeded", startedAt: 1, finishedAt: 2, summary: null, exitCode: 0 }],
      });
      const key = catalog.list().tasks[0].key;
      const calls: string[][] = [];
      const command = async (...args: string[]) => {
        calls.push(args);
        if (args[1] === "show") return { id: "auto_test", projectId: "proj_test", name: "Daily", enabled: true };
        throw new Error("BB delete failed");
      };
      await expect(manageBbCatalog(catalog, command, key, "delete")).rejects.toThrow("BB delete failed");
      expect(catalog.list().tasks).toHaveLength(1);
      await manageBbCatalog(catalog, async (...args) => {
        calls.push(args);
        return args[1] === "show" ? { id: "auto_test", projectId: "proj_test", name: "Daily", enabled: true } : { ok: true };
      }, key, "delete");
      expect(calls.at(-1)).toEqual(["automation", "delete", "auto_test", "--project", "proj_test", "--yes"]);
      expect(catalog.list().tasks).toHaveLength(0);
      expect(db.prepare("SELECT count(*) AS total FROM automation_catalog_runs").get()).toEqual({ total: 0 });
    } finally {
      db.close();
    }
  });
});
