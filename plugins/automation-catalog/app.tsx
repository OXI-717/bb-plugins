import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { catalogRpcContract } from "./src/catalog";
import type { CatalogList } from "./src/catalog-types";
import { CatalogDetailView } from "./detail";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { catalogSchedule } from "./lib/catalog-schedule";
import { emptyFilters, readFilters, matchesFilters, storageKey, stateLabel } from "./lib/filters";

export function CatalogPage() {
  const rpc = useRpc<typeof catalogRpcContract>();
  const [data, setData] = useState<CatalogList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState(readFilters);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(Date.now);
  const refresh = useCallback(() => {
    rpc.call("catalog_list").then(value => { setData(value); setError(null); }, cause => setError(String(cause)));
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("automation-catalog", refresh);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(timer); }, []);
  useEffect(() => { try { sessionStorage.setItem(storageKey, JSON.stringify(filters)); } catch {} setPage(0); }, [filters]);
  if (selected) return <div className="h-full overflow-y-auto"><CatalogDetailView key={selected} taskKey={selected} onBack={() => setSelected(null)} /></div>;
  const tasks = data?.tasks ?? [];
  const matched = tasks.filter(task => matchesFilters(task, filters));
  const lastPage = Math.max(0, Math.ceil(matched.length / 50) - 1);
  const currentPage = Math.min(page, lastPage);
  return <div className="h-full min-h-0 overflow-y-auto"><main className="mx-auto max-w-5xl space-y-4 p-4">
    <header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-semibold">Automation Catalog</h1><Button variant="outline" onClick={refresh}>Refresh</Button></header>
    <p className="text-sm text-muted-foreground">Personal and team automations, managed by their original schedulers. Collection does not call a model.</p>
    <div className="flex flex-wrap gap-2">
      <Input aria-label="Search automations" placeholder="Search automations" value={filters.query} onChange={e => setFilters({ ...filters, query: e.target.value })} />
      {(["source", "scope", "host", "state", "project"] as const).map(field => {
        const values = [...new Set(tasks.map(t => field === "source" ? t.sourceId : field === "project" ? t.projectId : t[field]).filter((v): v is string => !!v))];
        if (field === "source" && tasks.some(t => t.scheduler === "bb") && !values.includes("bb")) values.unshift("bb");
        return <select key={field} aria-label={`Filter ${field}`} className="min-w-0 max-w-full flex-1 basis-36 rounded-md border bg-background p-2 text-sm" value={filters[field]} onChange={e => setFilters({ ...filters, [field]: e.target.value })}>
          <option value="">All {field}s</option>{values.map(v => <option key={v} value={v}>{field === "source" ? data?.sources.find(s => s.id === v)?.name ?? v : v === "unknown" ? "Not reported" : v}</option>)}
        </select>;
      })}
      <Button variant="outline" onClick={() => setFilters({ ...emptyFilters })}>Clear filters</Button>
    </div>
    {error && <p role="alert">{error}</p>}
    {data === null && !error && <p role="status">Loading catalog…</p>}
    <div className="space-y-1 text-xs text-muted-foreground">{data?.sources.filter(s => !filters.source || s.id === filters.source || (filters.source === "bb" && tasks.some(t => t.sourceId === s.id && t.scheduler === "bb"))).map(s => <p key={s.id}>{s.name} · {s.lastSuccessAt === null ? "Not synchronized" : new Date(s.lastSuccessAt).toLocaleString()}{s.lastSuccessAt === null || now - s.lastSuccessAt > s.staleAfterMs ? " · Stale" : ""}{s.error ? ` · ${s.error}` : ""}</p>)}</div>
    {data && <p className="text-sm text-muted-foreground">Showing {matched.length} of {tasks.length} automations</p>}
    {data && tasks.length === 0 && <div className="rounded-md border border-dashed p-5"><p>No sources connected yet.</p><p className="text-sm text-muted-foreground">Publish a snapshot using the supplied collector or connect your scheduler using the documented JSON format. Sources are opt-in.</p></div>}
    {data && tasks.length > 0 && matched.length === 0 && <p>No automations match these filters.</p>}
    <ul className="space-y-2">{matched.slice(currentPage * 50, currentPage * 50 + 50).map(t => <li key={t.key}><button className="w-full min-w-0 space-y-1 rounded-lg border bg-card p-3 text-left hover:bg-accent" onClick={() => setSelected(t.key)}>
      <div className="flex flex-wrap justify-between gap-2"><span className="break-words font-medium">{t.name}</span><span className="text-sm">{stateLabel(t)}</span></div>
      <p className="break-words text-sm text-muted-foreground">{data?.sources.find(s => s.id === t.sourceId)?.name ?? t.sourceId} · {t.host} · {t.scope === "unknown" ? "Ownership not specified" : t.scope}</p>
      <p className="break-words text-sm">{catalogSchedule(t.schedule)}</p>
      {t.declaredState && <p className="text-sm">Declared state: {t.declaredState}</p>}
      {t.lastRun && <p className="text-sm">Last result: {t.lastRun.status === "unknown" ? "Outcome not reported" : t.lastRun.status} · {t.lastRun.startedAt === null ? "Run time not reported" : new Date(t.lastRun.startedAt).toLocaleString()}</p>}
    </button></li>)}</ul>
    {matched.length > 50 && <div className="flex gap-2"><Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button><span>{currentPage + 1} / {lastPage + 1}</span><Button disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next</Button></div>}
  </main></div>;
}
export default definePluginApp(app => { app.slots.navPanel({ id: "catalog", title: "Automation Catalog", icon: "Repeat", path: "catalog", component: CatalogPage }); });
