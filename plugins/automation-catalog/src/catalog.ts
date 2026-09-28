import { composeRequestSchema, hostRequest } from "./compose";
import { readRunResult, runResultSchema } from "./run-result";
import { refreshBbCatalog } from "./bb-refresh.js";
import { manageBbCatalog } from "./bb-management.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { Db } from "./data.js";
import {
  catalogSnapshotSchema,
  catalogEntrySchema,
  catalogRunSchema,
  catalogSourceStatusSchema,
  catalogListSchema,
  catalogDetailInputSchema,
  catalogDetailSchema,
} from "./catalog-types.js";

export const catalogMigration = `
CREATE TABLE automation_catalog_sources (id TEXT PRIMARY KEY, checked_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE automation_catalog_tasks (key TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES automation_catalog_sources(id), missing INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
CREATE INDEX automation_catalog_tasks_source ON automation_catalog_tasks(source_id);
CREATE TABLE automation_catalog_runs (task_key TEXT NOT NULL REFERENCES automation_catalog_tasks(key), id TEXT NOT NULL, started_at INTEGER, data TEXT NOT NULL, PRIMARY KEY(task_key, id));
CREATE INDEX automation_catalog_runs_time ON automation_catalog_runs(task_key, started_at DESC, id);
`;
const stored = z.object({ data: z.string() });
const execFileAsync = promisify(execFile);
function decode<T>(row: unknown, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(stored.parse(row).data));
}
function taskKey(source: string, host: string, id: string) {
  return (
    "ext_" +
    createHash("sha256")
      .update(JSON.stringify([source, host, id]))
      .digest("hex")
      .slice(0, 40)
  );
}
function sameLocalServer(configured?: string, actual?: string) {
  if (!configured || !actual) return false;
  try {
    const expected = new URL(actual);
    const selected = new URL(configured);
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
    return loopback.has(expected.hostname) && loopback.has(selected.hostname)
      && expected.protocol === selected.protocol && expected.port === selected.port
      && expected.pathname === selected.pathname && !selected.username && !selected.password
      && !selected.search && !selected.hash;
  } catch { return false; }
}
export function createCatalog(db: Db) {
  function source(id: string) {
    return decode(
      db
        .prepare("SELECT data FROM automation_catalog_sources WHERE id = ?")
        .get(id),
      catalogSourceStatusSchema,
    );
  }
  function entry(key: string) {
    const row = db
      .prepare(
        "SELECT data, missing FROM automation_catalog_tasks WHERE key = ?",
      )
      .get(key);
    if (!row) throw new Error("External automation not found");
    return {
      ...decode(row, catalogEntrySchema),
      missing: z.object({ missing: z.number() }).parse(row).missing === 1,
    };
  }
  return {
    setBbState(key: string, state: "active" | "paused") {
      const task = entry(key);
      if (!source(task.sourceId).managedHere || task.scheduler !== "bb" || task.missing)
        throw new Error("Only current BB automations can be updated");
      db.prepare("UPDATE automation_catalog_tasks SET data = ? WHERE key = ?").run(
        JSON.stringify({ ...task, state, nextRunAt: state === "paused" ? null : task.nextRunAt, observedAt: Date.now() }), key,
      );
    },
    remove(key: string) {
      return db.transaction(() => {
        entry(key);
        db.prepare("DELETE FROM automation_catalog_runs WHERE task_key = ?").run(key);
        db.prepare("DELETE FROM automation_catalog_tasks WHERE key = ?").run(key);
        return { ok: true as const };
      })();
    },
    forgetMissing(key: string) {
      return db.transaction(() => {
        const task = entry(key);
        if (!task.missing) throw new Error("Only missing catalog entries can be removed");
        db.prepare("DELETE FROM automation_catalog_runs WHERE task_key = ?").run(key);
        db.prepare("DELETE FROM automation_catalog_tasks WHERE key = ? AND missing = 1").run(key);
        return { ok: true as const };
      })();
    },
    entry,
    recordedRun(key: string, runId: string) {
      const row = db.prepare("SELECT data FROM automation_catalog_runs WHERE task_key = ? AND id = ?").get(key, runId);
      if (!row) throw new Error("Запуск не найден в истории этой автоматизации.");
      return decode(row, catalogRunSchema);
    },
    publish(input: unknown, localBbServerUrl?: string) {
      const snapshot = catalogSnapshotSchema.parse(input);
      const managedHere = sameLocalServer(snapshot.source.bbServerUrl, localBbServerUrl);
      if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > 4_000_000)
        throw new Error("Snapshot exceeds 4 MB");
      return db.transaction(() => {
        const resolved = new Map<string, string>();
        const identityKey = (host: string, id: string) => {
          const identity = snapshot.source.bbServerUrl ? id : JSON.stringify([host, id]);
          const cached = resolved.get(identity);
          if (cached) return cached;
          if (snapshot.source.bbServerUrl) {
            const existing = db.prepare("SELECT key FROM automation_catalog_tasks WHERE source_id = ? AND json_extract(data, '$.id') = ? ORDER BY missing ASC LIMIT 1").get(snapshot.source.id, id) as { key: string } | undefined;
            if (existing) {
              resolved.set(identity, existing.key);
              return existing.key;
            }
          }
          const key = taskKey(snapshot.source.id, host, id);
          resolved.set(identity, key);
          return key;
        };
        const previous = db
          .prepare("SELECT data FROM automation_catalog_sources WHERE id = ?")
          .get(snapshot.source.id);
        const old = previous
          ? decode(previous, catalogSourceStatusSchema)
          : null;
        if (old && snapshot.observedAt < old.checkedAt)
          throw new Error("Snapshot is older than stored data");
        const keys = new Set(
          snapshot.tasks.map((task) =>
            identityKey(task.host, task.id),
          ),
        );
        if (keys.size !== snapshot.tasks.length)
          throw new Error("Duplicate task identity");
        for (const run of snapshot.runs) {
          if (!keys.has(identityKey(run.host, run.taskId)))
            throw new Error("Run references a missing task");
        }
        const { bbServerUrl: _bbServerUrl, ...publicSource } = snapshot.source;
        const status = {
          ...publicSource,
          managedHere: snapshot.error === null ? managedHere : (old?.managedHere ?? managedHere),
          taskIds:
            snapshot.error === null ? snapshot.source.taskIds : old?.taskIds,
          checkedAt: snapshot.observedAt,
          lastSuccessAt:
            snapshot.error === null
              ? snapshot.observedAt
              : (old?.lastSuccessAt ?? null),
          error: snapshot.error,
        };
        db.prepare(
          "INSERT INTO automation_catalog_sources VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at, data=excluded.data",
        ).run(status.id, status.checkedAt, JSON.stringify(status));
        if (snapshot.error !== null) return { ok: true as const };
        db.prepare(
          "UPDATE automation_catalog_tasks SET missing = 1 WHERE source_id = ?",
        ).run(status.id);
        for (const task of snapshot.tasks) {
          const key = identityKey(task.host, task.id);
          const value = {
            ...task,
            key,
            sourceId: status.id,
            observedAt: snapshot.observedAt,
            missing: false,
          };
          db.prepare(
            "INSERT INTO automation_catalog_tasks VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET missing=0, data=excluded.data",
          ).run(key, status.id, JSON.stringify(value));
        }
        for (const run of snapshot.runs) {
          const key = identityKey(run.host, run.taskId);
          const previousRun = db
            .prepare(
              "SELECT data FROM automation_catalog_runs WHERE task_key = ? AND id = ?",
            )
            .get(key, run.id);
          if (previousRun) {
            const oldRun = decode(previousRun, catalogRunSchema);
            if (
              ["succeeded", "failed", "cancelled", "skipped"].includes(
                oldRun.status,
              ) &&
              ["queued", "running"].includes(run.status)
            )
              continue;
          }
          db.prepare(
            "INSERT INTO automation_catalog_runs VALUES (?, ?, ?, ?) ON CONFLICT(task_key,id) DO UPDATE SET started_at=excluded.started_at, data=excluded.data",
          ).run(key, run.id, run.startedAt, JSON.stringify(run));
        }
        return { ok: true as const };
      })();
    },
    list() {
      const tasks = db
        .prepare(
          "SELECT data, missing, (SELECT data FROM automation_catalog_runs WHERE task_key = automation_catalog_tasks.key AND COALESCE(json_extract(data, '$.evidence'), 'execution') = 'execution' ORDER BY COALESCE(started_at, json_extract(data, '$.finishedAt'), json_extract(data, '$.observedAt'), 0) DESC, id DESC LIMIT 1) AS last_run FROM automation_catalog_tasks WHERE EXISTS (SELECT 1 FROM automation_catalog_sources AS source WHERE source.id = automation_catalog_tasks.source_id AND (json_extract(source.data, '$.taskIds') IS NULL OR json_extract(automation_catalog_tasks.data, '$.id') IN (SELECT value FROM json_each(source.data, '$.taskIds')))) ORDER BY key",
        )
        .all()
        .map((row) => ({
          ...decode(row, catalogEntrySchema),
          missing: z.object({ missing: z.number() }).parse(row).missing === 1,
          lastRun: (() => {
            const raw = z
              .object({ last_run: z.string().nullable() })
              .parse(row).last_run;
            return raw === null
              ? null
              : catalogRunSchema.parse(JSON.parse(raw));
          })(),
        }));
      const sources = db
        .prepare("SELECT data FROM automation_catalog_sources ORDER BY id")
        .all()
        .map((row) => decode(row, catalogSourceStatusSchema));
      return catalogListSchema.parse({ tasks, sources });
    },
    detail(input: z.input<typeof catalogDetailInputSchema>) {
      const { key, offset, limit } = catalogDetailInputSchema.parse(input);
      const task = entry(key);
      const runs = db
        .prepare(
          "SELECT data FROM automation_catalog_runs WHERE task_key = ? ORDER BY COALESCE(started_at, json_extract(data, '$.finishedAt'), json_extract(data, '$.observedAt'), 0) DESC, id DESC LIMIT ? OFFSET ?",
        )
        .all(key, limit, offset)
        .map((row) => decode(row, catalogRunSchema));
      const { total } = z
        .object({ total: z.number() })
        .parse(
          db
            .prepare(
              "SELECT count(*) AS total FROM automation_catalog_runs WHERE task_key = ?",
            )
            .get(key),
        );
      const latest = db
        .prepare(
          "SELECT data FROM automation_catalog_runs WHERE task_key = ? AND COALESCE(json_extract(data, '$.evidence'), 'execution') = 'execution' ORDER BY COALESCE(started_at, json_extract(data, '$.finishedAt'), json_extract(data, '$.observedAt'), 0) DESC, id DESC LIMIT 1",
        )
        .get(key);
      return catalogDetailSchema.parse({
        task: {
          ...task,
          lastRun: latest ? decode(latest, catalogRunSchema) : null,
        },
        source: source(task.sourceId),
        runs,
        total,
      });
    },
  };
}

export const catalogRpcContract = defineRpcContract({
  catalog_run_result: {
    input: z.object({ key: z.string().min(1).max(300), runId: z.string().min(1).max(300) }).strict(),
    output: runResultSchema,
  },
  catalog_refresh: {
    input: z.null(),
    output: z.object({ refreshed: z.array(z.string()), deferred: z.array(z.string()) }),
  },
  catalog_forget_missing: {
    input: z.object({ key: z.string().min(1) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  catalog_manage_bb: {
    input: z.object({ key: z.string().min(1), action: z.enum(["pause", "resume", "delete"]) }).strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  catalog_compose: {
    input: z.object({ request: composeRequestSchema, title: z.string().trim().min(1).max(200), parentThreadId: z.string().min(1), taskKey: z.string().min(1).optional() }).strict(),
    output: z.object({ threadId: z.string() }),
  },
  catalog_compose_context: {
    input: z.object({ taskKey: z.string().min(1).optional() }).strict(),
    output: z.object({ parentThreadId: z.string(), parentTitle: z.string(), projectId: z.string() }),
  },
  catalog_list: { input: z.null(), output: catalogListSchema },
  catalog_detail: {
    input: catalogDetailInputSchema,
    output: catalogDetailSchema,
  },
  catalog_publish: {
    input: catalogSnapshotSchema,
    output: z.object({ ok: z.literal(true) }),
  },
});
export function registerCatalog(bb: BbPluginApi, db: Db) {
  const catalog = createCatalog(db);
  const settings = bb.settings.define({
    parentThreadId: { type: "string", label: "Родительский тред каталога", description: "Тред BB, под которым группируются обсуждения автоматизаций. Его проект используется по умолчанию для новых и внешних автоматизаций.", default: "" },
  });
  async function composeContext(taskKey?: string) {
    const { parentThreadId } = await settings.get();
    if (!parentThreadId.trim()) throw new Error("Укажите родительский тред каталога в настройках плагина перед созданием обсуждения.");
    const parent = await bb.sdk.threads.get({ threadId: parentThreadId });
    if (parent.archivedAt !== null) throw new Error("Родительский тред каталога архивирован. Выберите действующий тред в настройках плагина.");
    const detail = taskKey ? catalog.detail({ key: taskKey, offset: 0, limit: 1 }) : null;
    if (detail?.task.missing) throw new Error("Автоматизация удалена из источника. Создание обсуждения недоступно.");
    return { parentThreadId: parent.id, parentTitle: parent.title || "Каталог автоматизаций", projectId: detail?.source.managedHere && detail.task.projectId ? detail.task.projectId : parent.projectId };
  }
  async function bbCli(...args: string[]) {
    const serverUrl = bb.server.loopbackBaseUrl;
    const { stdout } = await execFileAsync(process.env.BB_CLI || "bb", [...args, "--json"], {
      env: { ...process.env, BB_SERVER_URL: serverUrl },
      timeout: 15000,
      maxBuffer: args.includes("--output") ? 8 * 1024 * 1024 : 1024 * 1024,
    });
    return JSON.parse(stdout) as Record<string, unknown>;
  }
  bb.rpc.register(catalogRpcContract, {
    catalog_run_result: ({ key, runId }) => readRunResult(catalog, bbCli, key, runId),
    catalog_refresh: async () => {
      const result = await refreshBbCatalog(catalog, bbCli, bb.server.loopbackBaseUrl);
      for (const sourceId of result.refreshed) bb.realtime.publish("automation-catalog", { sourceId });
      return result;
    },
    catalog_forget_missing: ({ key }) => {
      const result = catalog.forgetMissing(key);
      bb.realtime.publish("automation-catalog", { key });
      return result;
    },
    catalog_manage_bb: async ({ key, action }) => {
      const sourceId = catalog.entry(key).sourceId;
      const result = await manageBbCatalog(catalog, bbCli, key, action);
      bb.realtime.publish("automation-catalog", { sourceId });
      return result;
    },
    catalog_compose_context: ({ taskKey }) => composeContext(taskKey),
    catalog_compose: async ({ request, title, parentThreadId, taskKey }) => {
      const context = await composeContext(taskKey);
      if (context.parentThreadId !== parentThreadId) throw new Error("Привязка каталога изменилась. Откройте черновик заново.");
      const thread = await bb.sdk.threads.spawn({
        ...hostRequest(request),
        title,
        parentThreadId: context.parentThreadId,
        pluginMetadata: { kind: "automation-discussion", taskKey: taskKey ?? null },
      });
      return { threadId: thread.id };
    },
    catalog_list: () => catalog.list(),
    catalog_detail: (input) => catalog.detail(input),
    catalog_publish: (input) => {
      const result = catalog.publish(input, bb.server.loopbackBaseUrl);
      bb.realtime.publish("automation-catalog", { sourceId: input.source.id });
      return result;
    },
  });
  return catalog;
}
