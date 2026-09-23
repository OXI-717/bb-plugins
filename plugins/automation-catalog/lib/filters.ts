import type { CatalogTask } from "../src/catalog-types";
export const storageKey = "bb:automation-catalog:filters:v1";
export const emptyFilters = { query: "", source: "", scope: "", host: "", state: "", project: "" };
export type Filters = typeof emptyFilters;
export function readFilters(): Filters {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    if (value && typeof value === "object" && Object.keys(emptyFilters).every(k => typeof (value as Record<string, unknown>)[k] === "string")) {
      return Object.fromEntries(Object.keys(emptyFilters).map(k => [k, (value as Record<string, string>)[k]])) as Filters;
    }
  } catch {}
  return { ...emptyFilters };
}
export function matchesFilters(t: CatalogTask, f: Filters) {
  return (!f.query || [t.name, t.id, t.host, t.owner, t.team].some(v => v?.toLowerCase().includes(f.query.trim().toLowerCase()))) &&
    (!f.source || t.sourceId === f.source || (f.source === "bb" && t.scheduler === "bb")) &&
    (!f.scope || t.scope === f.scope) && (!f.host || t.host === f.host) && (!f.state || t.state === f.state) && (!f.project || t.projectId === f.project);
}
export function stateLabel(t: CatalogTask) {
  return t.missing ? "Missing from source" : t.state === "unknown" ? "Live status not connected" : t.state;
}
