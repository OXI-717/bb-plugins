import { z } from "zod";
import { runSchema } from "./work";

const text = z.string().max(1000);
const count = z.number().finite().nonnegative().nullable();
export const projectSchema = z.object({
  name: text,
  host: text,
  state: z.enum(["enabled", "disabled", "paused", "unknown"]),
  countsAt: text.nullable().default(null),
  countsError: text.nullable().default(null),
  issues: count,
  autoPrs: count,
  devPrs: count,
  partial: z.boolean(),
  engines: z.array(text).max(50),
  local: z.boolean().default(false),
  engineControls: z.object({host:text,checkedAt:text,error:text.nullable(),paused:z.array(z.object({engine:text,reason:text})).max(50)}).nullable().default(null),
  fleetRevision: z.string().regex(/^[0-9a-f]{40}$/).nullable().default(null),
  executionPlan: z
    .array(
      z.object({
        engine: text,
        taskModel: text,
        taskEffort: text,
        reviewModel: text,
        reviewEffort: text,
      }),
    )
    .max(50)
    .default([]),
  fixEngines: z.array(text).max(20).default([]),
  allowPremiumAuto: z.boolean().default(false),
  engineCatalog: z.array(z.object({engine:text,taskModel:text,taskEffort:text,reviewModel:text,reviewEffort:text})).max(50).default([]),
  repoCount: count.default(null),
  maxPrs: count.default(null),
  policy: text.default(""),
});
export const pipelineSchema = z.object({
  id: text,
  repo: text,
  status: text,
  engine: text,
  updatedAt: text,
});
export const statusSchema = z.object({
  projects: z.array(projectSchema).max(300),
  alerts: z.array(text).max(300),
  budgets: z
    .array(z.object({ engine: text, remaining: count, weekly: count, disabled: z.boolean().default(false), detail: text.default("") }))
    .max(50),
  lastCycle: text.nullable(),
});
export const collectionSchema = z.object({
  status: statusSchema,
  pipelines: z.array(pipelineSchema).max(200),
  pipelineError: text.nullable(),
  runs: z.array(runSchema).max(300).default([]),
  runsError: text.nullable().default(null),
});
export type Status = z.infer<typeof statusSchema>;
export type Collection = z.infer<typeof collectionSchema>;
export const sourceSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,48}$/),
    label: z.string().min(1).max(100),
    hostId: z.string().min(1),
    executable: z.string().startsWith("/").max(1024),
    taskRunnerHome: z.string().startsWith("/").max(1024),
    fleetPath: z.string().startsWith("/").max(1024).optional(),
  })
  .strict();
export const sourcesSchema = z
  .array(sourceSchema)
  .max(12)
  .refine(
    (a) => new Set(a.map((x) => x.id)).size === a.length,
    "Source IDs must be unique",
  );
export type Source = z.infer<typeof sourceSchema>;
export const snapshotSchema = z.object({
  source: sourceSchema,
  attemptedAt: text,
  updatedAt: text.nullable(),
  error: text.nullable(),
  data: collectionSchema.nullable(),
});
export type Snapshot = z.infer<typeof snapshotSchema>;

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const str = (v: unknown, fallback = "—") =>
  typeof v === "string" ? v.slice(0, 1000) : fallback;
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const strings = (v: unknown) =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .slice(0, 300)
        .map((x) => x.slice(0, 1000))
    : [];
export function parseStatus(output: string): Record<string, unknown> {
  // JSONL logging may precede the final pretty-printed object; never accept a log as status.
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== "{" && !lines[i].includes('"projects"')) continue;
    try {
      const value = JSON.parse(lines.slice(i).join("\n"));
      if (Array.isArray(value.projects)) return value;
    } catch {}
  }
  throw new Error("Источник не вернул полный JSON статуса");
}
export function normalizeStatus(raw: Record<string, unknown>): Status {
  if (!Array.isArray(raw.projects) || raw.projects.length > 300)
    throw new Error("Некорректный список проектов");
  const kill = record(raw.kill_switch);
  const paused = strings(kill.projects);
  const alerts = strings(raw.fleet_warnings);
  if (raw.registry_error) alerts.push(str(raw.registry_error));
  if (raw.fleet_unavailable) alerts.push(str(raw.fleet_unavailable));
  if (raw.counts_unavailable)
    alerts.push("Счётчики задач и PR получены не полностью");
  for (const [project, repos] of Object.entries(record(raw.quarantine)))
    for (const value of Object.values(record(repos)))
      alerts.push(
        `${project}: карантин — ${str(record(value).reason)}`.slice(0, 1000),
      );
  return statusSchema.parse({
    projects: raw.projects.map((value) => {
      const p = record(value);
      return {
        name: str(p.name),
        local: p.runtime_kind === "local" || p.host === "mac",
        repoCount: num(p.repo_count),
        maxPrs: num(p.max_prs),
        policy: str(p.dev_policy, ""),
        executionPlan: (Array.isArray(p.engine_selections)
          ? p.engine_selections
          : []
        )
          .slice(0, 50)
          .map((v) => {
            const x = record(v);
            return {
              engine: str(x.engine),
              taskModel: str(x.dev_model, str(x.model)),
              taskEffort: str(x.dev_effort, str(x.effort)),
              reviewModel: str(x.review_model, str(x.model)),
              reviewEffort: str(x.review_effort, str(x.effort)),
            };
          }),
        fixEngines: strings(p.fix_engine_chain).slice(0, 20),
        allowPremiumAuto: p.allow_premium_auto === true,
        engineCatalog: (Array.isArray(p.engine_catalog)?p.engine_catalog:[]).slice(0,50).map(v=>{
          const x=record(v);return {engine:str(x.engine),taskModel:str(x.dev_model),taskEffort:str(x.dev_effort),reviewModel:str(x.review_model),reviewEffort:str(x.review_effort)};
        }),
        host: str(p.host),
        state:
          p.source === "fleet-invalid"
            ? "unknown"
            : p.enabled === false
              ? "disabled"
              : kill.global === true || paused.includes(str(p.name))
                ? "paused"
                : p.enabled === true
                  ? "enabled"
                  : "unknown",
        issues: num(p.open_issues),
        autoPrs: num(p.auto_prs),
        devPrs: num(p.dev_prs),
        partial: p.counts_partial === true,
        engines: strings(p.engine_chain).slice(0, 50),
      };
    }),
    alerts: alerts.slice(0, 300),
    budgets: (Array.isArray(raw.budget) ? raw.budget : [])
      .slice(0, 50)
      .map((value) => {
        const b = record(value);
        return {
          engine: str(b.engine),
          disabled: b.disabled === true,
          detail: str(b.detail, ""),
          remaining: b.reachable === true ? num(b.remaining_5h) : null,
          weekly:
            b.reachable === true && b.weekly_supported !== false
              ? num(b.remaining_weekly)
              : null,
        };
      }),
    lastCycle:
      typeof record(raw.last_cycle).ts === "string"
        ? str(record(raw.last_cycle).ts)
        : null,
  });
}
export function normalizePipeline(id: string, raw: unknown, updatedAt: string) {
  const p = record(raw);
  return pipelineSchema.parse({
    id,
    repo: str(p.repo_name, str(p.repo, str(p.repo_path))),
    status: str(p.status),
    engine: str(p.engine),
    updatedAt,
  });
}
