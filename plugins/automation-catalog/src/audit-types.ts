import { z } from "zod";

const text = (max: number) => z.string().trim().max(max);
const id = z.string().trim().min(1).max(300);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const auditOutcomeSchema = z.enum(["passed", "partial", "failed", "not-run"]);
export const auditDecisionSchema = z.enum(["keep", "disable", "delete", "replace", "defer", "delegate", "undecided"]);
export const auditAppendSchema = z.object({
  key: id,
  idempotencyKey: id,
  checkedAt: time.optional(),
  outcome: auditOutcomeSchema,
  decision: auditDecisionSchema,
  summary: text(2000).min(1),
  checks: text(4000).min(1),
  changes: text(4000).default(""),
  remaining: text(4000).default(""),
  evidence: z.array(text(1000).min(1)).max(16).default([]),
  authorThreadId: id.nullable().default(null),
}).strict().refine(value => value.outcome !== "passed" || value.evidence.length > 0, {
  message: "Для успешной проверки укажите подтверждение результата.", path: ["evidence"],
});
export const auditRecordSchema = z.object({
  id,
  key: id,
  recordedAt: time,
  checkedAt: time,
  kind: z.enum(["audit", "action"]),
  task: z.object({ id, name: id, sourceId: id, host: id, projectId: id.nullable() }).strict(),
  outcome: auditOutcomeSchema,
  decision: auditDecisionSchema,
  summary: text(2000),
  checks: text(4000),
  changes: text(4000),
  remaining: text(4000),
  evidence: z.array(text(1000)).max(16),
  authorThreadId: id.nullable(),
}).strict();
export const auditListInputSchema = z.object({
  key: id.optional(),
  query: text(300).default(""),
  offset: z.number().int().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export const auditListSchema = z.object({
  records: z.array(auditRecordSchema.extend({ presentInCatalog: z.boolean() })),
  total: z.number().int().nonnegative(),
});
export type AuditRecord = z.infer<typeof auditRecordSchema>;
export type AuditList = z.infer<typeof auditListSchema>;
export type AuditAppend = z.input<typeof auditAppendSchema>;
