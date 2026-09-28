import type { CatalogTask } from "../src/catalog-types";
// Older collectors stored the execution mode in the host field. Keep persisted
// identities intact, but never present this sentinel as an actual machine.
export function hostName(t: Pick<CatalogTask, "host" | "hostLabel">): string | null {
  return t.host === "BB-managed agent" ? null : t.hostLabel ?? t.host;
}
export const storageKey = "bb:automation-catalog:filters:v2";
export const emptyFilters = { query: "", source: "", scope: "", host: "", state: "", project: "" };
export type Filters = typeof emptyFilters;
export function readFilters(): Filters {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (value && typeof value === "object" && Object.keys(emptyFilters).every(k => typeof (value as Record<string, unknown>)[k] === "string")) {
      const restored = Object.fromEntries(Object.keys(emptyFilters).map(k => [k, (value as Record<string, string>)[k]])) as Filters;
      if (restored.host === "BB-managed agent") restored.host = "";
      return restored;
    }
  } catch {}
  return { ...emptyFilters, state: "current" };
}
export function matchesFilters(t: CatalogTask, f: Filters) {
  return (!f.query || [t.name, t.id, t.host, t.hostLabel, t.projectName, t.owner, t.team].some(v => v?.toLowerCase().includes(f.query.trim().toLowerCase()))) &&
    (!f.source || t.sourceId === f.source || (f.source === "bb" && t.scheduler === "bb")) &&
    (!f.scope || t.scope === f.scope) && (!f.host || hostName(t) === f.host) && (!f.state || t.state === f.state) && (!f.project || t.projectId === f.project);
}
export function stateLabel(t: CatalogTask) {
  return t.missing ? "Отсутствует в источнике" : t.state === "unknown" ? "Состояние не подключено" : t.state;
}
