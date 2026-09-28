import { z } from "zod";
import type { createCatalog } from "./catalog";

export const runResultSchema = z.object({
  status: z.string(), output: z.string().nullable(), error: z.string().nullable(),
  threadId: z.string().nullable(), truncated: z.boolean(),
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
  const limit = 50000;
  return { status: run.status, output: run.output?.slice(0, limit) ?? null, error: run.error?.slice(0, limit) ?? null,
    threadId: run.threadId, truncated: (run.output?.length ?? 0) > limit || (run.error?.length ?? 0) > limit };
}
