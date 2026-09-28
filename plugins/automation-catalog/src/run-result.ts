import { z } from "zod";
import type { createCatalog } from "./catalog";

export const runResultSchema = z.object({
  status: z.string(), hasOutput: z.boolean(), hasError: z.boolean(),
  threadId: z.string().nullable(), nativeUrl: z.string(),
});
const sourceRun = z.object({
  id: z.string(), automationId: z.string(), status: z.string(),
  output: z.string().nullable(), error: z.string().nullable(), threadId: z.string().nullable(),
});
export async function readRunResult(catalog: ReturnType<typeof createCatalog>, command: (...args: string[]) => Promise<unknown>, key: string, runId: string) {
  const { task, source } = catalog.detail({ key, limit: 1 });
  if (!source.managedHere || task.scheduler !== "bb" || !task.projectId || task.missing)
    throw new Error("Просмотр вывода доступен только для текущих автоматизаций этого BB.");
  catalog.recordedRun(key, runId);
  let value: unknown;
  try {
    value = await command("automation", "runs", task.id, "--project", task.projectId, "--limit", "200", "--output", runId);
  } catch {
    throw new Error("Не удалось прочитать результат. Здесь доступны 200 последних запусков BB; более ранние проверьте в исходной системе.");
  }
  const run = sourceRun.parse(value);
  if (run.id !== runId || run.automationId !== task.id) throw new Error("Результат не соответствует выбранному запуску.");
  // Raw logs stay server-side; the panel receives navigation metadata only.
  return { status: run.status, hasOutput: !!run.output?.trim(), hasError: !!run.error?.trim(),
    threadId: run.threadId,
    nativeUrl: `/plugins/automations/automations/${encodeURIComponent(task.projectId)}/${encodeURIComponent(task.id)}` };
}
