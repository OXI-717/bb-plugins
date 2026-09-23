import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { catalogMigration } from "./catalog.js";
import { createCatalog } from "./catalog.js";

const databases: Database.Database[] = [];
function setup() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(catalogMigration);
  return { db, catalog: createCatalog(db) };
}
function snapshot(observedAt = 1000) {
  return {
    source: { id: "test", name: "Team server", staleAfterMs: 3600000 },
    observedAt,
    error: null,
    tasks: [
      {
        id: "daily",
        name: "Daily summary",
        host: "worker-example",
        scope: "team",
        owner: "operator",
        team: "Example Team",
        projectId: null,
        scheduler: "systemd",
        executor: "Python",
        schedule: "0 9 * * * Europe/Moscow",
        state: "active",
        description: "Summary",
        history: "available",
        url: null,
      },
    ],
    runs: [
      {
        taskId: "daily",
        host: "worker-example",
        id: "run-1",
        status: "succeeded",
        startedAt: 100,
        finishedAt: 200,
        summary: "Done",
        exitCode: 0,
      },
    ],
  };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("external catalog", () => {
  it("keeps a BB task identity and history when its host label changes", () => {
    const { catalog } = setup();
    const first = snapshot();
    first.source.id = "bb-main";
    first.tasks[0].scheduler = "bb";
    catalog.publish(first);
    const key = catalog.list().tasks[0].key;
    const next = { ...snapshot(2000), source: first.source, tasks: [{ ...first.tasks[0], host: "renamed-host" }], runs: [{ ...first.runs[0], host: "renamed-host", id: "run-2" }] };
    catalog.publish(next);
    expect(catalog.list().tasks).toHaveLength(1);
    expect(catalog.list().tasks[0].key).toBe(key);
    expect(catalog.detail({ key }).total).toBe(2);
  });
  it("removes only a missing projection and its history, without touching a live record with the same scheduler ID", () => {
    const { catalog } = setup();
    const old = snapshot();
    catalog.publish(old);
    const staleKey = catalog.list().tasks[0].key;
    const current = { ...snapshot(2000), tasks: [{ ...old.tasks[0], host: "new-host", name: "Current task" }], runs: [{ ...old.runs[0], host: "new-host", id: "new-run" }] };
    catalog.publish(current);
    const activeKey = catalog.list().tasks.find((task) => !task.missing)!.key;
    expect(() => catalog.forgetMissing(activeKey)).toThrow(/Only missing/);
    expect(catalog.forgetMissing(staleKey)).toEqual({ ok: true });
    expect(catalog.list().tasks.map((task) => task.key)).toEqual([activeKey]);
    expect(() => catalog.detail({ key: staleKey })).toThrow(/not found/);
    expect(catalog.detail({ key: activeKey }).total).toBe(1);
  });
  it("hides deselected imports while preserving history and selection during outages", () => {
    const { catalog } = setup();
    catalog.publish(snapshot());
    const key = catalog.list().tasks[0].key;
    catalog.publish({ ...snapshot(2000), source: { ...snapshot().source, taskIds: [] }, tasks: [], runs: [] });
    expect(catalog.list().tasks).toEqual([]);
    expect(catalog.detail({ key }).total).toBe(1);
    catalog.publish({ ...snapshot(3000), error: "Unavailable", tasks: [], runs: [] });
    expect(catalog.list().tasks).toEqual([]);
    catalog.publish({ ...snapshot(4000), source: { ...snapshot().source, taskIds: ["daily"] } });
    expect(catalog.list().tasks[0].key).toBe(key);
    expect(catalog.detail({ key }).total).toBe(1);
  });
  it("keeps lifecycle events separate from execution outcomes", () => {
    const { catalog } = setup();
    const input = snapshot();
    catalog.publish({
      ...input,
      runs: [
        ...input.runs,
        {
          ...input.runs[0],
          id: "event-1",
          evidence: "state-change",
          status: "unknown",
          startedAt: null,
          finishedAt: 3000,
          exitCode: null,
        },
      ],
    });
    const task = catalog.list().tasks[0];
    expect(task.lastRun?.status).toBe("succeeded");
    const history = catalog.detail({ key: task.key, offset: 0, limit: 25 });
    expect(history.runs[0].evidence).toBe("state-change");
    expect(history.total).toBe(2);
  });
  it("deduplicates source identities and never creates schedulable work", () => {
    const { db, catalog } = setup();
    catalog.publish(snapshot());
    catalog.publish(snapshot());
    const list = catalog.list();
    expect(list.tasks).toHaveLength(1);
    expect(
      catalog.detail({ key: list.tasks[0].key, offset: 0, limit: 25 }).task
        .lastRun,
    ).toEqual(list.tasks[0].lastRun);
    expect(
      catalog.detail({ key: list.tasks[0].key, offset: 0, limit: 25 }).runs,
    ).toHaveLength(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='automations'").get()).toBeUndefined();
  });
  it("retains last good data during outages and marks tasks missing only on complete snapshots", () => {
    const { catalog } = setup();
    catalog.publish(snapshot());
    catalog.publish({
      ...snapshot(2000),
      error: "Source unavailable",
      tasks: [],
      runs: [],
    });
    expect(catalog.list().tasks[0].missing).toBe(false);
    expect(catalog.list().sources[0].lastSuccessAt).toBe(1000);
    catalog.publish({ ...snapshot(3000), tasks: [], runs: [] });
    expect(catalog.list().tasks[0].missing).toBe(true);
    expect(
      catalog.detail({ key: catalog.list().tasks[0].key, offset: 0, limit: 25 })
        .runs,
    ).toHaveLength(1);
  });
  it("rejects stale or inconsistent snapshots atomically", () => {
    const { catalog } = setup();
    catalog.publish(snapshot());
    expect(() => catalog.publish(snapshot(999))).toThrow(/older/i);
    const invalid = snapshot(2000);
    invalid.runs[0].taskId = "missing";
    expect(() => catalog.publish(invalid)).toThrow(/task/i);
    expect(catalog.list().sources[0].checkedAt).toBe(1000);
  });
  it("keeps identical task IDs on different hosts separate", () => {
    const { catalog } = setup();
    const input = snapshot();
    input.tasks.push({ ...input.tasks[0], host: "other-host" });
    catalog.publish(input);
    expect(new Set(catalog.list().tasks.map((task) => task.key)).size).toBe(2);
  });
  it("validates unsafe links, unknown fields and invented completion times", () => {
    const { catalog } = setup();
    expect(() =>
      catalog.publish({ ...snapshot(), secret: "unexpected" }),
    ).toThrow();
    const input = snapshot();
    expect(() =>
      catalog.publish({
        ...input,
        tasks: [{ ...input.tasks[0], url: "javascript:alert(1)" }],
      }),
    ).toThrow();
    expect(() =>
      catalog.publish({
        ...input,
        runs: [{ ...input.runs[0], finishedAt: 50 }],
      }),
    ).toThrow();
  });
});

it("enforces snapshot size in UTF-8 bytes before writing", () => {
  const { catalog } = setup();
  const input = snapshot();
  input.tasks = Array.from({ length: 1100 }, (_, index) => ({ ...input.tasks[0], id: `task-${index}`, description: "я".repeat(1900) }));
  input.runs = [];
  expect(() => catalog.publish(input)).toThrow("Snapshot exceeds 4 MB");
  expect(catalog.list()).toEqual({ tasks: [], sources: [] });
});
