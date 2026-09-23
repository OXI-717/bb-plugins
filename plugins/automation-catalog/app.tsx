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
  sourceLabel,
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
  const filteredTasks = tasks.filter((task) => matchesFilters(task, { ...filters, state: "" }));
  const views = [
    { id: "", label: "Все", count: filteredTasks.length },
    {
      id: "attention",
      label: "Требуют внимания",
      count: filteredTasks.filter((t) => states.get(t.key)!.attention).length,
    },
    {
      id: "running",
      label: "Выполняются / в очереди",
      count: filteredTasks.filter((t) =>
        ["running", "queued"].includes(t.lastRun?.status ?? ""),
      ).length,
    },
    {
      id: "paused",
      label: "Отключены",
      count: filteredTasks.filter((t) => states.get(t.key)!.paused).length,
    },
    {
      id: "unmonitored",
      label: "Без данных о запусках",
      count: filteredTasks.filter((t) => t.history === "not-connected").length,
    },
  ];
  const matched = filteredTasks
    .filter(
      (t) =>
        !filters.state ||
        (filters.state === "attention"
          ? states.get(t.key)!.attention
          : filters.state === "paused"
            ? states.get(t.key)!.paused
            : filters.state === "unmonitored"
              ? t.history === "not-connected"
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
            <h1 className="text-xl font-semibold">Автоматизации</h1>
            <p className="text-xs text-muted-foreground">
              Запуски, расписания и результаты из подключённых систем
            </p>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={refresh}>
              Обновить
            </Button>
            <Button
              size="sm"
              onClick={() => setCreating(!creating)}
              aria-expanded={creating}
            >
              Создать автоматизацию
            </Button>
          </div>
        </header>
        {creating && (
          <section
            aria-label="Создать автоматизацию"
            className="rounded-md border bg-card p-4 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-medium">Где запускать?</h2>
              <select
                aria-label="Тип автоматизации"
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={creationScope}
                onChange={(e) => setCreationScope(e.target.value)}
              >
                <option value="personal">Личная</option>
                <option value="team">Командная</option>
              </select>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {creationTypes.map((type) => (
                <button
                  key={type.id}
                  className="rounded-md border p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    setCompose({
                      title: `Создать ${creationScope === "team" ? "командную" : "личную"} автоматизацию · ${type.label}`,
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
              Откроется подготовленный запрос в BB. Добавьте описание задачи и отправьте
              его, чтобы начать настройку.
            </p>
          </section>
        )}
        <nav
          aria-label="Разделы автоматизаций"
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
            aria-label="Поиск автоматизаций"
            placeholder="Поиск автоматизаций…"
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
                      source: "Все источники",
                      scope: "Любой тип",
                      host: "Все хосты",
                      project: "Все проекты",
                    }[field]
                  }
                </option>
                {field === "source" && filters.source === "bb" && (
                  <option value="bb">BB</option>
                )}
                {values.map((v) => (
                  <option key={v} value={v}>
                    {field === "source"
                      ? sourceLabel(data?.sources.find((s) => s.id === v)?.name ?? v)
                      : field === "scope"
                        ? scopeLabel(v)
                        : field === "project"
                          ? (tasks.find((t) => t.projectId === v)
                              ?.projectName ?? "Проект не указан")
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
            Сбросить
          </Button>
        </div>
        {error && (
          <div role="alert" className="rounded-md border p-3 text-sm">
            <p>
              Не удалось обновить каталог. Последние загруженные данные
              сохранены.
            </p>
            <details className="text-xs text-muted-foreground">
              <summary>Подробности соединения</summary>
              {error}
            </details>
          </div>
        )}
        {data === null && !error && <p role="status">Загрузка автоматизаций…</p>}
        {data && (
          <p className="text-xs text-muted-foreground">
            Показано: {matched.length} из {filteredTasks.length}
          </p>
        )}
        {data && matched.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {tasks.length
              ? "По заданным фильтрам автоматизаций нет."
              : "Нет подключённых автоматизаций. Создайте новую или подключите источник."}
          </p>
        )}
        {matched.length > 0 && (
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-left text-sm">
              <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Автоматизация / источник</th>
                  <th className="px-3 py-2 font-medium">Состояние</th>
                  <th className="hidden px-3 py-2 font-medium md:table-cell">
                    Расписание
                  </th>
                  <th className="hidden px-3 py-2 font-medium lg:table-cell">
                    Последний запуск
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
                            {sourceLabel(data?.sources.find((s) => s.id === t.sourceId)
                              ?.name ?? t.sourceId)}{" "}
                            · {scopeLabel(t.scope)}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground md:hidden">
                            {catalogSchedule(t.schedule)}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground lg:hidden">
                            {t.lastRun
                              ? `${runLabel(t.lastRun.status)} · ${timestamp(t.lastRun.startedAt ?? t.lastRun.finishedAt)}`
                              : t.history === "not-connected" ? "История не подключена" : "Данных о запусках нет"}
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
                              Следующий запуск: {timestamp(t.nextRunAt)}
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
                                    Время не сохранено
                                  </p>
                                )}
                            </>
                          ) : (
                            <span className="text-muted-foreground">
                              {t.history === "not-connected" ? "История не подключена" : "Данных о запусках нет"}
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
              Назад
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
              Далее
            </Button>
          </div>
        )}
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            Подключённые источники ({data?.sources.length ?? 0})
          </summary>
          <div className="mt-2 space-y-2">
            {data?.sources.map((s) => (
              <p key={s.id}>
                {sourceLabel(s.name)} · Обновлено {timestamp(s.lastSuccessAt)}
                {s.error
                  ? " · Ошибка соединения"
                  : s.lastSuccessAt === null ||
                      now - s.lastSuccessAt > s.staleAfterMs
                    ? " · Данные устарели"
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
    title: "Каталог автоматизаций",
    icon: "Repeat",
    path: "catalog",
    component: CatalogPage,
  });
});
