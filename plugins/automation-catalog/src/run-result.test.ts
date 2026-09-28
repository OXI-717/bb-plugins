import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { catalogMigration, createCatalog } from "./catalog";
import { readRunResult } from "./run-result";

it("reads only the selected locally owned run, bounds text, and never persists output", async () => {
  const db = new Database(":memory:");
  try {
    db.exec(catalogMigration);
    const catalog = createCatalog(db);
    const snapshot = {
      source: { id: "bb-example", name: "Example", staleAfterMs: 60000, bbServerUrl: "http://127.0.0.1:38886" },
      observedAt: 1, error: null,
      tasks: [{ id: "auto_example", name: "Report", host: "example", scope: "personal", owner: null, team: null, projectId: "proj_example", scheduler: "bb", executor: "script", schedule: null, state: "active", description: "", history: "available", url: null }],
      runs: [{ id: "run_example", taskId: "auto_example", host: "example", status: "succeeded", startedAt: 1, finishedAt: 2, summary: null, exitCode: 0 }],
    };
    catalog.publish(snapshot, "http://127.0.0.1:38886");
    const key = catalog.list().tasks[0].key;
    const calls: string[][] = [];
    const response = { id: "run_example", automationId: "auto_example", status: "succeeded", output: "PRIVATE_RESULT".repeat(6000), error: null, threadId: "thread_example" };
    const command = async (...args: string[]) => { calls.push(args); return response; };
    const result = await readRunResult(catalog, command, key, "run_example");
    expect(result.output).toHaveLength(50000);
    expect(result.truncated).toBe(true);
    expect(calls[0]).toEqual(["automation", "runs", "auto_example", "--project", "proj_example", "--limit", "200", "--output", "run_example"]);
    expect(JSON.stringify(catalog.detail({ key }))).not.toContain("PRIVATE_RESULT");
    await expect(readRunResult(catalog, command, key, "foreign_run")).rejects.toThrow("не найден");
    expect(calls).toHaveLength(1);
    await expect(readRunResult(catalog, async () => ({ ...response, automationId: "other" }), key, "run_example")).rejects.toThrow("не соответствует");
    await expect(readRunResult(catalog, async () => { throw new Error("private source error"); }, key, "run_example")).rejects.toThrow("200 последних");
    catalog.publish({ ...snapshot, source: { ...snapshot.source, bbServerUrl: "https://remote.example.com" }, observedAt: 2 }, "http://127.0.0.1:38886");
    await expect(readRunResult(catalog, command, key, "run_example")).rejects.toThrow("этого BB");
    expect(calls).toHaveLength(1);
  } finally { db.close(); }
});
