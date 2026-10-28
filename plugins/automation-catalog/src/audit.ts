import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db } from "./data";
import type { CatalogTask } from "./catalog-types";
import { auditAppendSchema, auditListInputSchema, auditListSchema, auditRecordSchema, type AuditAppend, type AuditRecord } from "./audit-types";

// Deliberately no foreign key: deleting a scheduler projection must retain its audit.
export const auditMigration = `
CREATE TABLE automation_catalog_audits (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  task_key TEXT NOT NULL, request_key TEXT NOT NULL, request TEXT NOT NULL,
  recorded_at INTEGER NOT NULL, search_text TEXT NOT NULL, data TEXT NOT NULL,
  UNIQUE(task_key, request_key)
);
CREATE INDEX automation_catalog_audits_task ON automation_catalog_audits(task_key, seq DESC);
`;
const stored = z.object({ data: z.string() });
const decode = (row: unknown) => auditRecordSchema.parse(JSON.parse(stored.parse(row).data));

export function createAuditJournal(db: Db, task: (key: string) => CatalogTask) {
  return {
    append(value: AuditAppend, kind: AuditRecord["kind"] = "audit") {
      const input = auditAppendSchema.parse(value);
      const { key, idempotencyKey, ...body } = input;
      const request = JSON.stringify({ kind, ...body });
      if (Buffer.byteLength(request, "utf8") > 32_000) throw new Error("Запись аудита превышает 32 КБ.");
      return db.transaction(() => {
        const previous = db.prepare("SELECT request, data FROM automation_catalog_audits WHERE task_key=? AND request_key=?").get(key, idempotencyKey);
        if (previous) {
          if (z.object({ request: z.string() }).parse(previous).request !== request)
            throw new Error("Ключ повторного запроса уже использован для другой записи.");
          return decode(previous);
        }
        let identity: AuditRecord["task"];
        try {
          const current = task(key);
          identity = { id: current.id, name: current.name, sourceId: current.sourceId, host: current.host, projectId: current.projectId };
        } catch (cause) {
          if (!(cause instanceof Error) || cause.message !== "External automation not found") throw cause;
          const latest = db.prepare("SELECT data FROM automation_catalog_audits WHERE task_key=? ORDER BY seq DESC LIMIT 1").get(key);
          if (!latest) throw new Error("Автоматизация не найдена: нужен существующий каталог или сохранённый аудит.");
          identity = decode(latest).task;
        }
        const now = Date.now();
        const record = auditRecordSchema.parse({ ...body, id: randomUUID(), key, kind, recordedAt: now, checkedAt: input.checkedAt ?? now, task: identity });
        const data = JSON.stringify(record);
        db.prepare("INSERT INTO automation_catalog_audits(id,task_key,request_key,request,recorded_at,search_text,data) VALUES (?,?,?,?,?,?,?)")
          .run(record.id, key, idempotencyKey, request, now, data.toLocaleLowerCase("ru"), data);
        return record;
      })();
    },
    list(value: z.input<typeof auditListInputSchema>) {
      const { key, query, offset, limit } = auditListInputSchema.parse(value);
      const params = [key ?? null, key ?? null, query.toLocaleLowerCase("ru")];
      const where = "(? IS NULL OR task_key=?) AND instr(search_text,?)>0";
      const records = db.prepare(`SELECT data, EXISTS(SELECT 1 FROM automation_catalog_tasks WHERE key=task_key) AS present FROM automation_catalog_audits WHERE ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset).map(row => ({ ...decode(row), presentInCatalog: z.object({ present: z.number() }).parse(row).present === 1 }));
      const { total } = z.object({ total: z.number() }).parse(db.prepare(`SELECT COUNT(*) AS total FROM automation_catalog_audits WHERE ${where}`).get(...params));
      return auditListSchema.parse({ records, total });
    },
  };
}
