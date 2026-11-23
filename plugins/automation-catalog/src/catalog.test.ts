import Database from "better-sqlite3";
import { attentionFingerprint, health } from "../lib/operations";
import { afterEach, describe, expect, it } from "vitest";
import { catalogMigration } from "./catalog.js";
import { createCatalog } from "./catalog.js";

const databases: Database.Database[] = [];
describe("durable incident review", () => {
  it("retires review after recovery even when a later failure has the same fingerprint", () => {
    const { catalog } = setup();
    const bad = { ...snapshot(), runs: [] }; bad.tasks[0].state = "failed";
    catalog.publish(bad);
    const task = catalog.list().tasks[0];
    catalog.review(task.key, attentionFingerprint(task), "Checked");
    catalog.publish({ ...bad, observedAt: 2000, tasks: [{ ...bad.tasks[0], state: "active" }] });
    expect(catalog.list().tasks[0].review).toBeNull();
    catalog.publish({ ...bad, observedAt: 3000 });
    expect(health(catalog.list().tasks[0]).attention).toBe(true);
  });
  it("survives refresh, rejects stale clicks and exposes the next failure", () => {
    const { catalog } = setup();
    const first = snapshot(Date.now()); first.runs[0].status = "failed";
    catalog.publish(first);
    const task = catalog.list().tasks[0];
    catalog.review(task.key, attentionFingerprint(task), "Checked: no action needed");
    catalog.publish({ ...first, observedAt: first.observedAt + 1 });
    expect(health(catalog.list().tasks[0]).attention).toBe(false);
    expect(catalog.detail({ key: task.key }).task.review?.note).toBe("Checked: no action needed");
    catalog.publish({ ...first, observedAt: first.observedAt + 2, runs: [{ ...first.runs[0], id: "run-2", startedAt: 300, finishedAt: 400 }] });
    expect(health(catalog.list().tasks[0]).attention).toBe(true);
    expect(() => catalog.review(task.key, attentionFingerprint(task), "Stale click")).toThrow("Состояние изменилось");
    expect(catalog.detail({ key: task.key }).total).toBe(2);
  });
  it("can undo review and refuses to mark a healthy task", () => {
    const { catalog } = setup(); catalog.publish(snapshot());
    let task = catalog.list().tasks[0];
    expect(() => catalog.review(task.key, attentionFingerprint(task), "Not a failure")).toThrow();
    const bad = snapshot(2000); bad.runs[0].status = "failed"; catalog.publish(bad); task = catalog.list().tasks[0];
    catalog.review(task.key, attentionFingerprint(task), "Checked");
    catalog.review(task.key, attentionFingerprint(task), null);
    expect(health(catalog.list().tasks[0]).attention).toBe(true);
  });
});
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
  it("updates a display label without changing external identity or losing runs", () => {
    const { catalog } = setup();
    catalog.publish(snapshot());
    const key = catalog.list().tasks[0].key;
    const next = snapshot(2000);
    catalog.publish({ ...next, tasks: next.tasks.map(t => ({ ...t, hostLabel: "team-worker-example" })), runs: [] });
    expect(catalog.list().tasks).toHaveLength(1);
    expect(catalog.list().tasks[0]).toMatchObject({ key, host: "worker-example", hostLabel: "team-worker-example" });
    expect(catalog.detail({ key }).total).toBe(1);
  });
  it("keeps a BB task identity and history when its host label changes", () => {
    const { catalog } = setup();
    const first = { ...snapshot(), source: { ...snapshot().source, id: "bb-local", bbServerUrl: "http://127.0.0.1:38886" } };
    first.tasks[0].scheduler = "bb";
    catalog.publish(first, "http://127.0.0.1:38886");
    const key = catalog.list().tasks[0].key;
    const next = { ...snapshot(2000), source: first.source, tasks: [{ ...first.tasks[0], host: "renamed-host" }], runs: [{ ...first.runs[0], host: "renamed-host", id: "run-2" }] };
    catalog.publish(next, "http://127.0.0.1:38886");
    expect(catalog.list().tasks).toHaveLength(1);
    expect(catalog.list().tasks[0].key).toBe(key);
    expect(catalog.detail({ key }).total).toBe(2);
    expect(JSON.stringify(catalog.list())).not.toContain("38886");
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

describe("source archival", () => {
  it("preserves task history, allows restoration and treats a new publication as live", () => {
    const { catalog } = setup();
    const first = snapshot();
    catalog.publish(first);
    const key = catalog.list().tasks[0].key;
    const history = catalog.detail({ key }).runs;
    catalog.setSourceArchived("test", first.observedAt, true);
    expect(catalog.list().sources[0].archivedAt).toBeGreaterThan(0);
    expect(catalog.detail({ key }).runs).toEqual(history);
    expect(catalog.list().tasks[0].state).toBe("active");
    catalog.publish(first);
    expect(catalog.detail({ key }).source.archivedAt).toBeGreaterThan(0);
    catalog.setSourceArchived("test", first.observedAt, false);
    expect(catalog.list().sources[0].archivedAt).toBeUndefined();
    catalog.setSourceArchived("test", first.observedAt, true);
    catalog.publish({ ...first, observedAt: first.observedAt + 1 });
    expect(catalog.list().sources[0].archivedAt).toBeUndefined();
  });

  it("refuses an old receipt, a current source or a native BB source", () => {
    const { catalog } = setup();
    const first = snapshot(Date.now());
    catalog.publish(first);
    expect(() => catalog.setSourceArchived("test", first.observedAt - 1, true)).toThrow(/changed/);
    expect(() => catalog.setSourceArchived("test", first.observedAt, true)).toThrow(/fresh/);
    catalog.publish({ ...snapshot(), source: { ...first.source, id: "native", bbServerUrl: "http://127.0.0.1:38886" } }, "http://localhost:38886");
    expect(() => catalog.setSourceArchived("native", 1000, true)).toThrow(/BB/);
  });
});

describe("one-off execution classification", () => {
  it("preserves the card and old findings while binding the actual invocation", () => {
    const { catalog } = setup();
    const legacy = snapshot(3000);
    legacy.tasks[0].scheduler = "inventory-audit";
    legacy.runs[0] = { ...legacy.runs[0], id: "old-inventory-finding", startedAt: 3000, finishedAt: 3000, status: "succeeded" };
    catalog.publish(legacy);
    const key = catalog.list().tasks[0].key;
    const invocation = { ...snapshot(4000), tasks: [{ ...legacy.tasks[0], scheduler: "systemd", scheduleKind: "once" as const, state: "failed" as const, executionId: "systemd:invocation-one" }],
      runs: [{ ...legacy.runs[0], id: "systemd:invocation-one", startedAt: 1000, finishedAt: 2000, status: "failed" as const, exitCode: 70 }] };
    catalog.publish(invocation);
    expect(catalog.list().tasks[0]).toMatchObject({ key, state: "failed", lastRun: { id: "systemd:invocation-one", exitCode: 70 } });
    const detail = catalog.detail({ key });
    expect(detail.task.lastRun).toMatchObject({ id: "systemd:invocation-one", exitCode: 70 });
    expect(detail.total).toBe(2);
    expect(detail.runs.find(r => r.id === "old-inventory-finding")).toMatchObject({ startedAt: 3000, status: "succeeded" });
    catalog.publish({ ...invocation, observedAt: 5000, tasks: [{ ...invocation.tasks[0], executionId: "systemd:not-yet-published" }], runs: [] });
    expect(catalog.list().tasks[0].lastRun).toBeNull();
    expect(catalog.detail({ key }).task.lastRun).toBeNull();
    expect(catalog.detail({ key }).total).toBe(2);
  });
});

describe("bounded per-task run history and indexed queries", () => {
  it("prunes excess runs per task while preserving executionId and latest execution outcome", () => {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(catalogMigration);
    const catalog = createCatalog(db, { maxRunsPerTask: 5 });
    const base = snapshot(10_000);
    const runs = [
      { ...base.runs[0], id: "exec-pinned", evidence: "execution" as const, startedAt: 100, finishedAt: 110, observedAt: 110, status: "failed" as const, exitCode: 1 },
      { ...base.runs[0], id: "exec-latest", evidence: "execution" as const, startedAt: 200, finishedAt: 210, observedAt: 210, status: "succeeded" as const, exitCode: 0 },
      ...Array.from({ length: 12 }, (_, index) => ({
        ...base.runs[0],
        id: `state-${String(index).padStart(2, "0")}`,
        evidence: "state-change" as const,
        status: "unknown" as const,
        startedAt: null,
        finishedAt: null,
        observedAt: 1000 + index * 10,
        exitCode: null,
      })),
    ];
    catalog.publish({ ...base, tasks: [{ ...base.tasks[0], scheduleKind: "once" as const, executionId: "exec-pinned" }], runs });
    const list = catalog.list();
    expect(list.tasks).toHaveLength(1);
    const key = list.tasks[0].key;
    expect(list.tasks[0].lastRun?.id).toBe("exec-pinned");
    const detail = catalog.detail({ key, offset: 0, limit: 25 });
    expect(detail.total).toBe(7); // 5 newest state-changes + pinned executionId + latest execution
    const ids = detail.runs.map((run) => run.id);
    expect(ids).toContain("exec-pinned");
    expect(ids).toContain("exec-latest");
    expect(ids).toContain("state-11");
    expect(ids).not.toContain("state-00");
    // Dropping executionId still preserves latest execution outcome.
    catalog.publish({
      ...base,
      observedAt: 20_000,
      tasks: [{ ...base.tasks[0], scheduleKind: "recurring" as const }],
      runs: [{ ...runs[runs.length - 1], id: "state-12", observedAt: 2000 }],
    });
    expect(catalog.list().tasks[0].lastRun?.id).toBe("exec-latest");
    const after = catalog.detail({ key, offset: 0, limit: 25 });
    expect(after.total).toBe(6); // 5 newest state-changes + latest execution
    expect(after.runs.map((run) => run.id)).toContain("exec-latest");
  });

  it("avoids temporary B-tree sorting in detail and list run lookups", () => {
    const { db, catalog } = setup();
    catalog.publish(snapshot());
    const key = catalog.list().tasks[0].key;
    const detailPlan = db
      .prepare("EXPLAIN QUERY PLAN SELECT data FROM automation_catalog_runs WHERE task_key = ? ORDER BY sort_at DESC, id DESC LIMIT 25 OFFSET 0")
      .all(key) as Array<{ detail: string }>;
    const latestPlan = db
      .prepare("EXPLAIN QUERY PLAN SELECT data FROM automation_catalog_runs WHERE task_key = ? AND evidence = 'execution' ORDER BY sort_at DESC, id DESC LIMIT 1")
      .all(key) as Array<{ detail: string }>;
    expect(detailPlan.map((row) => row.detail).join("\n")).not.toContain("TEMP B-TREE");
    expect(latestPlan.map((row) => row.detail).join("\n")).not.toContain("TEMP B-TREE");
  });
});
