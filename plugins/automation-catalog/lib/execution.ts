import type { CatalogTask } from "../src/catalog-types";

export const unlinkedProject = "__catalog_unlinked_project__";
export function projectLabel(task: CatalogTask): string {
  if (!task.projectId) return task.projectName ? `${task.projectName} · без привязки к BB` : "Без привязки к проекту";
  return task.projectId === "proj_personal" ? "Личные автоматизации (Personal)" : task.projectName || "Название проекта не передано";
}
export function modelLabel(task: CatalogTask): string {
  const agent = task.agent;
  if (agent?.modelSource === "existing-thread") return `Модель из треда · в настройках: ${agent.model || "не указана"}`;
  if (agent || task.executor === "agent") return `Модель: ${agent?.model || "не передана источником"}${agent?.provider ? ` · ${agent.provider}` : ""}`;
  return "Вызовы моделей не проверены";
}
