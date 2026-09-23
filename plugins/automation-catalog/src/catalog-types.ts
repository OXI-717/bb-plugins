import { z } from "zod";

const text = z.string().max(2000);
const id = z.string().min(1).max(300);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const catalogTaskSchema = z
  .object({
    id,
    name: z.string().min(1).max(300),
    host: id,
    scope: z.enum(["personal", "team", "unknown"]),
    owner: text.nullable(),
    team: text.nullable(),
    projectId: id.nullable(),
    projectName: text.nullable().optional(),
    scheduler: id,
    executor: text,
    schedule: text.nullable(),
    nextRunAt: time.nullable().optional(),
    state: z.enum(["active", "paused", "blocked", "failed", "unknown"]),
    declaredState: text.nullable().optional(),
    description: text,
    history: z.enum(["available", "not-recorded", "not-connected"]),
    url: z
      .url()
      .max(2000)
      .refine((value) => new URL(value).protocol === "https:")
      .nullable(),
  })
  .strict();
export const catalogRunSchema = z
  .object({
    taskId: id,
    evidence: z.enum(["execution", "state-change"]).default("execution"),
    observedAt: time.nullable().default(null),
    host: id,
    id,
    status: z.enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "skipped",
      "unknown",
    ]),
    startedAt: time.nullable(),
    finishedAt: time.nullable(),
    summary: z.string().max(8000).nullable(),
    exitCode: z.number().int().nullable(),
  })
  .strict()
  .refine(
    (run) =>
      run.startedAt === null ||
      run.finishedAt === null ||
      run.finishedAt >= run.startedAt,
    "Completion precedes start",
  );
export const catalogSourceSchema = z
  .object({
    id,
    name: z.string().min(1).max(300),
    staleAfterMs: z.number().int().min(60000).max(604800000),
    taskIds: z.array(id).max(2000).optional(),
    bbServerUrl: z.url().max(2000).optional(),
  })
  .strict();
export const catalogSnapshotSchema = z
  .object({
    source: catalogSourceSchema,
    observedAt: time,
    error: text.nullable(),
    tasks: z.array(catalogTaskSchema).max(2000),
    runs: z.array(catalogRunSchema).max(5000),
  })
  .strict()
  .refine(
    (value) =>
      value.error === null ||
      (value.tasks.length === 0 && value.runs.length === 0),
    "Failed snapshots must not contain partial data",
  );
export const catalogEntrySchema = catalogTaskSchema.extend({
  key: id,
  sourceId: id,
  observedAt: time,
  missing: z.boolean(),
  lastRun: catalogRunSchema.nullable().default(null),
});
export const catalogSourceStatusSchema = catalogSourceSchema.omit({ bbServerUrl: true }).extend({
  managedHere: z.boolean().optional(),
  checkedAt: time,
  lastSuccessAt: time.nullable(),
  error: text.nullable(),
});
export const catalogListSchema = z.object({
  tasks: z.array(catalogEntrySchema),
  sources: z.array(catalogSourceStatusSchema),
});
export const catalogDetailInputSchema = z
  .object({
    key: id,
    offset: z.number().int().min(0).max(1000000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();
export const catalogDetailSchema = z.object({
  task: catalogEntrySchema,
  source: catalogSourceStatusSchema,
  runs: z.array(catalogRunSchema),
  total: z.number().int().nonnegative(),
});
export type CatalogTask = z.infer<typeof catalogEntrySchema>;
export type CatalogList = z.infer<typeof catalogListSchema>;
export type CatalogDetail = z.infer<typeof catalogDetailSchema>;
