import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { catalogMigration, createCatalog } from "./catalog";
import { auditMigration, createAuditJournal } from "./audit";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() {
  const db = new Database(":memory:"); databases.push(db);
  db.exec(catalogMigration); db.exec(auditMigration);
  const catalog = createCatalog(db);
  const snapshot = {
    source: { id: "example", name: "Example", staleAfterMs: 60000 }, observedAt: 1, error: null,
    tasks: [{ id: "daily", name: "Daily report", host: "example-host", scope: "personal", owner: null, team: null,
      projectId: null, scheduler: "systemd", executor: "script", schedule: null, state: "active", description: "", history: "available", url: null }], runs: [],
  };
  catalog.publish(snapshot);
  const key = catalog.list().tasks[0].key;
  const journal = createAuditJournal(db, key => catalog.detail({ key }).task);
  const input = { key, idempotencyKey: "first", outcome: "partial" as const, decision: "defer" as const, summary: "Проверены входные файлы", checks: "Read-only inspection", remaining: "Execution needs approval" };
  return { db, catalog, snapshot, key, journal, input };
}
it("retains independent audit history after refresh, deletion and a later correction", () => {
  const { catalog, snapshot, key, journal, input } = setup();
  const before = catalog.detail({ key }).task;
  const first = journal.append({ ...input, checkedAt: 100 });
  expect(catalog.detail({ key }).task).toEqual(before);
  catalog.publish({ ...snapshot, observedAt: 2, tasks: [{ ...snapshot.tasks[0], name: "Renamed report" }] });
  expect(journal.list({ key }).records[0].task.name).toBe("Daily report");
  catalog.remove(key);
  expect(journal.list({ key })).toMatchObject({ total: 1, records: [{ id: first.id, checkedAt: 100, presentInCatalog: false }] });
  journal.append({ ...input, idempotencyKey: "correction", summary: "Archived decision", decision: "delete" });
  expect(journal.list({ key }).total).toBe(2);
  expect(journal.list({ key }).records[0].task).toEqual(first.task);
});
it("deduplicates retries and rejects conflicting retries without rewriting history", () => {
  const { journal, input } = setup();
  const first = journal.append(input);
  expect(journal.append(input)).toEqual(first);
  expect(() => journal.append({ ...input, summary: "Different" })).toThrow(/Ключ повторного/);
  expect(journal.list({}).total).toBe(1);
});
it("searches case-insensitively and paginates without merging source identities", () => {
  const { journal, input, catalog, snapshot } = setup();
  journal.append(input);
  journal.append({ ...input, idempotencyKey: "second", summary: "Second" });
  catalog.publish({ ...snapshot, source: { ...snapshot.source, id: "other" } });
  const other = catalog.list().tasks.find(t => t.sourceId === "other")!;
  journal.append({ ...input, key: other.key, summary: "Other source" });
  expect(journal.list({ query: "ПРОВЕРЕНЫ" }).total).toBe(1);
  expect(journal.list({ key: input.key, offset: 1, limit: 1 })).toMatchObject({ total: 2, records: [{ summary: input.summary }] });
  expect(journal.list({ key: other.key }).total).toBe(1);
});
it("requires evidence for a pass and refuses unknown jobs and oversized records", () => {
  const { journal, input } = setup();
  expect(() => journal.append({ ...input, outcome: "passed" })).toThrow();
  expect(() => journal.append({ ...input, key: "unknown" })).toThrow(/не найдена/);
  expect(() => journal.append({ ...input, checks: "а".repeat(4000), changes: "а".repeat(4000), remaining: "а".repeat(4000), evidence: Array(16).fill("а".repeat(1000)) })).toThrow(/32 КБ/);
  expect(journal.list({}).total).toBe(0);
});
