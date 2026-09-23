import { hostname } from "node:os";
import { z } from "zod";
import type { createCatalog } from "./catalog.js";

type Catalog = ReturnType<typeof createCatalog>;
type Command = (...args: string[]) => Promise<unknown>;

const automation = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  execution: z.object({ mode: z.string(), interpreter: z.string().optional() }),
  trigger: z.object({
    triggerType: z.string(),
    cron: z.string().optional(),
    timezone: z.string().optional(),
    runAt: z.number().optional(),
  }),
  nextRunAt: z.number().nullable().optional(),
});
const overviewSchema = z.object({ automations: z.array(z.object({
  automation,
  project: z.object({ id: z.string(), name: z.string() }),
})) });
const runsSchema = z.object({ runs: z.array(z.object({
  id: z.string(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "skipped", "unknown"]),
  startedAt: z.number().nullable().optional(),
  finishedAt: z.number().nullable().optional(),
  exitCode: z.number().nullable().optional(),
  skipReason: z.string().nullable().optional(),
})) });

export async function refreshBbCatalog(catalog: Catalog, command: Command) {
  const current = catalog.list();
  const source = current.sources.find((item) => item.id === "bb-main");
  if (!source) throw new Error("Источник BB не подключён к каталогу");
  const overview = overviewSchema.parse(await command("plugin", "rpc", "call", "automations", "automations_overview"));
  const tasks = overview.automations.map(({ automation: item, project }) => {
    const executionHost = item.execution.mode === "script" ? hostname() : "BB-managed agent";
    const previous = current.tasks.find((task) => task.sourceId === source.id && task.id === item.id && !task.missing);
    const schedule = item.trigger.triggerType === "schedule"
      ? `${item.trigger.cron ?? ""} ${item.trigger.timezone ?? ""}`.trim()
      : item.trigger.runAt != null ? new Date(item.trigger.runAt).toISOString() : null;
    return {
      id: item.id,
      name: item.name,
      host: executionHost,
      scope: project.id === "proj_personal" ? "personal" as const : "unknown" as const,
      owner: null,
      team: null,
      projectId: project.id,
      projectName: project.name,
      scheduler: "bb",
      executor: item.execution.interpreter ?? item.execution.mode,
      schedule,
      nextRunAt: item.nextRunAt ?? null,
      state: item.enabled ? "active" as const : "paused" as const,
      description: previous?.description ?? `Managed by BB. Project: ${project.name}.`,
      history: "available" as const,
      url: null,
    };
  });
  const runGroups = await Promise.all(overview.automations.map(async ({ automation: item, project }) => {
    const response = runsSchema.parse(await command("automation", "runs", item.id, "--project", project.id, "--limit", "100"));
    const host = tasks.find((task) => task.id === item.id)!.host;
    return response.runs.map((run) => ({
      taskId: item.id,
      host,
      id: run.id,
      status: run.status,
      startedAt: run.startedAt ?? null,
      finishedAt: run.finishedAt ?? null,
      exitCode: run.exitCode ?? null,
      summary: run.skipReason ? `Skipped: ${run.skipReason.slice(0, 2000)}` : null,
    }));
  }));
  catalog.publish({
    source: { id: source.id, name: source.name, staleAfterMs: source.staleAfterMs },
    observedAt: Date.now(),
    error: null,
    tasks,
    runs: runGroups.flat(),
  });
  return { refreshed: [source.id], deferred: current.sources.filter((item) => item.id !== source.id).map((item) => item.id) };
}
