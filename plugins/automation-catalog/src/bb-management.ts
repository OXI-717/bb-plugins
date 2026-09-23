import { z } from "zod";
import type { createCatalog } from "./catalog.js";

type Catalog = ReturnType<typeof createCatalog>;
type Command = (...args: string[]) => Promise<unknown>;
const currentSchema = z.object({ id: z.string(), projectId: z.string(), name: z.string(), enabled: z.boolean() });

export async function manageBbCatalog(
  catalog: Catalog,
  command: Command,
  key: string,
  action: "pause" | "resume" | "delete",
) {
  const task = catalog.entry(key);
  const source = catalog.list().sources.find((item) => item.id === task.sourceId);
  if (!source?.managedHere || task.scheduler !== "bb" || !task.projectId || task.missing)
    throw new Error("Direct management is available only for current BB automations");
  const current = currentSchema.parse(await command("automation", "show", task.id, "--project", task.projectId));
  if (current.id !== task.id || current.projectId !== task.projectId || current.name !== task.name)
    throw new Error("The BB automation identity changed. Refresh the catalog.");
  if (action === "pause" && !current.enabled) throw new Error("Already disabled");
  if (action === "resume" && current.enabled) throw new Error("Already enabled");
  await command("automation", action, task.id, "--project", task.projectId, ...(action === "delete" ? ["--yes"] : []));
  if (action === "delete") catalog.remove(key);
  else catalog.setBbState(key, action === "pause" ? "paused" : "active");
  return { ok: true as const };
}
