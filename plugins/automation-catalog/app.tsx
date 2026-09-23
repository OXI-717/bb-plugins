import { AutomationComposer, type ComposeIntent } from "./compose";
import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { catalogRpcContract } from "./src/catalog";
import type { CatalogList } from "./src/catalog-types";
import { CatalogDetailView } from "./detail";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { catalogSchedule } from "./lib/catalog-schedule";
import {
  emptyFilters,
  readFilters,
  matchesFilters,
  storageKey,
} from "./lib/filters";
import {
  health,
  runLabel,
  timestamp,
  scopeLabel,
  creationTypes,
  creationPrompt,
} from "./lib/operations";

export function CatalogPage() {
  const rpc = useRpc<typeof catalogRpcContract>();
  const [compose, setCompose] = useState<ComposeIntent | null>(null);
  const [data, setData] = useState<CatalogList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState(readFilters);
  const [selected, setSelected] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [creating, setCreating] = useState(false);
  const [creationScope, setCreationScope] = useState("personal");
  const refresh = useCallback(() => {
    rpc.call("catalog_list").then(
      (value) => {
        setData(value);
        setError(null);
      },
      (cause) => setError(String(cause)),
    );
  }, [rpc]);
  useEffect(refresh, [refresh]);
  useRealtime("automation-catalog", refresh);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(filters));
    } catch {}
    setPage(0);
  }, [filters]);
  if (compose)
    return (
      <AutomationComposer intent={compose} onBack={() => setCompose(null)} />
    );
  if (selected)
    return (
      <div className="h-full overflow-y-auto">
        <CatalogDetailView
          key={selected}
          taskKey={selected}
          onBack={() => setSelected(null)}
        />
      </div>
    );
  const tasks = data?.tasks ?? [];
  const states = new Map(
    tasks.map((t) => [
      t.key,
      health(
        t,
        data?.sources.find((s) => s.id === t.sourceId),
        now,
      ),
    ]),
  );
  const views = [
    { id: "", label: "All", count: tasks.length },
    {
      id: "attention",
      label: "Needs attention",
      count: tasks.filter((t) => states.get(t.key)!.attention).length,
    },
    {
      id: "running",
      label: "Running / queued",
      count: tasks.filter((t) =>
        ["running", "queued"].includes(t.lastRun?.status ?? ""),
      ).length,
    },
    {
      id: "paused",
      label: "Paused",
      count: tasks.filter((t) => states.get(t.key)!.paused).length,
    },
  ];
  const matched = tasks
    .filter((task) => matchesFilters(task, { ...filters, state: "" }))
    .filter(
      (t) =>
        !filters.state ||
        (filters.state === "attention"
          ? states.get(t.key)!.attention
          : filters.state === "paused"
            ? states.get(t.key)!.paused
            : filters.state === "running"
              ? ["running", "queued"].includes(t.lastRun?.status ?? "")
              : t.state === filters.state),
    )
    .sort(
      (a, b) =>
        Number(states.get(b.key)!.attention) -
          Number(states.get(a.key)!.attention) ||
        states.get(a.key)!.rank - states.get(b.key)!.rank ||
        a.name.localeCompare(b.name),
    );
  const lastPage = Math.max(0, Math.ceil(matched.length / 50) - 1);
  const currentPage = Math.min(page, lastPage);
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <main className="mx-auto max-w-7xl space-y-4 p-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-xl font-semibold">Automations</h1>
            <p className="text-xs text-muted-foreground">
              Execution, schedules and results across your connected systems
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={refresh}>
              Refresh
            </Button>
            <Button
              size="sm"
              onClick={() => setCreating(!creating)}
              aria-expanded={creating}
            >
              Create automation
            </Button>
          </div>
        </header>
        {creating && (
          <section
            aria-label="Create automation"
            className="rounded-md border bg-card p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">Where should it run?</h2>
              <select
                aria-label="Automation ownership"
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={creationScope}
                onChange={(e) => setCreationScope(e.target.value)}
              >
                <option value="personal">Personal</option>
                <option value="team">Team</option>
              </select>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {creationTypes.map((type) => (
                <button
                  key={type.id}
                  className="rounded-md border p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    setCompose({
                      title: `Create ${creationScope} ${type.label}`,
                      prompt: creationPrompt(type.id, creationScope),
                      draftKey: `catalog:create:${type.id}:${creationScope}`,
                    })
                  }
                >
                  <span className="block text-sm font-medium">
                    {type.label} →
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {type.description}
                  </span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Opens a prepared request in BB. Add the task description and send
              it to start setup.
            </p>
          </section>
        )}
        <nav
          aria-label="Automation views"
          className="flex flex-wrap gap-1 border-b pb-2"
        >
          {views.map((view) => (
            <Button
              size="sm"
              key={view.id}
              variant="ghost"
              aria-pressed={filters.state === view.id}
              onClick={() => setFilters({ ...filters, state: view.id })}
            >
              {view.label}
              <span
                className={
                  view.id === "attention" && view.count
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {view.count}
              </span>
            </Button>
          ))}
        </nav>
        <div className="flex flex-wrap gap-2">
          <Input
            className="h-8 w-full sm:w-64"
            aria-label="Search automations"
            placeholder="Search automations…"
            value={filters.query}
            onChange={(e) => setFilters({ ...filters, query: e.target.value })}
          />
          {(["source", "scope", "host", "project"] as const).map((field) => {
            const values = [
              ...new Set(
                tasks
                  .map((t) =>
                    field === "source"
                      ? t.sourceId
                      : field === "project"
                        ? t.projectId
                        : t[field],
                  )
                  .filter((v): v is string => !!v),
              ),
            ];
            return (
              <select
                key={field}
                aria-label={`Filter ${field}`}
                className="h-8 min-w-0 max-w-full rounded-md border bg-background px-2 text-xs"
                value={filters[field]}
                onChange={(e) =>
                  setFilters({ ...filters, [field]: e.target.value })
                }
              >
                <option value="">
                  {
                    {
                      source: "All sources",
                      scope: "All ownership",
                      host: "All hosts",
                      project: "All projects",
                    }[field]
                  }
                </option>
                {field === "source" && filters.source === "bb" && (
                  <option value="bb">BB</option>
                )}
                {values.map((v) => (
                  <option key={v} value={v}>
                    {field === "source"
                      ? (data?.sources.find((s) => s.id === v)?.name ?? v)
                      : field === "scope"
                        ? scopeLabel(v)
                        : field === "project"
                          ? (tasks.find((t) => t.projectId === v)
                              ?.projectName ?? "Project name unavailable")
                          : v}
                  </option>
                ))}
              </select>
            );
          })}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFilters({ ...emptyFilters })}
          >
            Clear
          </Button>
        </div>
        {error && (
          <div role="alert" className="rounded-md border p-3 text-sm">
            <p>
              Could not refresh the catalog. Your last loaded inventory is
              preserved.
            </p>
            <details className="text-xs text-muted-foreground">
              <summary>Connection details</summary>
              {error}
            </details>
          </div>
        )}
        {data === null && !error && <p role="status">Loading automations…</p>}
        {data && (
          <p className="text-xs text-muted-foreground">
            {matched.length} automations · Problems first
          </p>
        )}
        {data && matched.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {tasks.length
              ? "No automations match these filters."
              : "No automations connected. Create one or connect a source."}
          </p>
        )}
        {matched.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Automation / source</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">
                    Schedule
                  </th>
                  <th className="hidden px-3 py-2 font-medium lg:table-cell">
                    Last execution
                  </th>
                </tr>
              </thead>
              <tbody>
                {matched
                  .slice(currentPage * 50, currentPage * 50 + 50)
                  .map((t) => {
                    const state = states.get(t.key)!;
                    return (
                      <tr
                        key={t.key}
                        className="border-b last:border-0 hover:bg-muted/40"
                      >
                        <td className="max-w-64 px-3 py-3 align-top">
                          <button
                            className="text-left font-medium hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                            onClick={() => setSelected(t.key)}
                          >
                            {t.name}
                          </button>
                          <p className="mt-1 break-words text-xs text-muted-foreground">
                            {data?.sources.find((s) => s.id === t.sourceId)
                              ?.name ?? t.sourceId}{" "}
                            · {scopeLabel(t.scope)}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground md:hidden">
                            {catalogSchedule(t.schedule)}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground lg:hidden">
                            {t.lastRun
                              ? `${runLabel(t.lastRun.status)} · ${timestamp(t.lastRun.startedAt ?? t.lastRun.finishedAt)}`
                              : "No execution received"}
                          </p>
                        </td>
                        <td className="max-w-48 px-3 py-3 align-top">
                          <span
                            className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${state.tone === "danger" ? "border-destructive/40 text-destructive" : state.attention ? "border-foreground/40" : "border-border text-muted-foreground"}`}
                          >
                            {state.attention ? "! " : ""}
                            {state.label}
                          </span>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {state.reason}
                          </p>
                        </td>
                        <td className="hidden max-w-64 px-3 py-3 align-top text-xs md:table-cell">
                          {catalogSchedule(t.schedule)}
                          {t.nextRunAt != null && (
                            <p className="mt-1 text-muted-foreground">
                              Next: {timestamp(t.nextRunAt)}
                            </p>
                          )}
                        </td>
                        <td className="hidden px-3 py-3 align-top text-xs lg:table-cell">
                          {t.lastRun ? (
                            <>
                              <span
                                className={
                                  t.lastRun.status === "failed"
                                    ? "font-medium text-destructive"
                                    : ""
                                }
                              >
                                {runLabel(t.lastRun.status)}
                              </span>
                              <p className="mt-1 text-muted-foreground">
                                {timestamp(
                                  t.lastRun.startedAt ?? t.lastRun.finishedAt,
                                )}
                              </p>
                              {t.lastRun.startedAt === null &&
                                t.lastRun.finishedAt === null && (
                                  <p className="text-muted-foreground">
                                    Time not retained
                                  </p>
                                )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">
                              No execution received
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
        {matched.length > 50 && (
          <div className="flex items-center justify-end gap-2 text-xs">
            <Button
              size="sm"
              variant="ghost"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </Button>
            <span>
              {currentPage + 1} / {lastPage + 1}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={currentPage === lastPage}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            Connected sources ({data?.sources.length ?? 0})
          </summary>
          <div className="mt-2 space-y-2">
            {data?.sources.map((s) => (
              <p key={s.id}>
                {s.name} · Updated {timestamp(s.lastSuccessAt)}
                {s.error
                  ? " · Connection problem"
                  : s.lastSuccessAt === null ||
                      now - s.lastSuccessAt > s.staleAfterMs
                    ? " · Data out of date"
                    : ""}
              </p>
            ))}
          </div>
        </details>
      </main>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "catalog",
    title: "Automation Catalog",
    icon: "Repeat",
    path: "catalog",
    component: CatalogPage,
  });
});
