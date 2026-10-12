import {useRpc} from "./rpc";
import { Fragment, useCallback, useEffect, useState } from "react";
import { definePluginApp,  useRealtime } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import type { Snapshot } from "./model";
import {
  observedSummary,
  workSummary,
  type ProjectDetail,
  type Run,
} from "./work";
import { Button } from "./components/ui/button";
import {
  number,
  date,
  ago,
  tones,
  Section,
  Empty,
  Metric,
  type Row,
  type DetailState,
} from "./view";
import { ProjectPanel } from "./project-panel";
export function Dashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [detailKey, setDetailKey] = useState<string | null>(null);
  function selectProject(key: string) {
    setSelected((current) => (current === key ? null : key));
  }
  const [observations, setObservations] = useState<
    { sourceId: string; project: string; at: string; rows: string[] }[]
  >([]);
  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null),
    [error, setError] = useState<string | null>(null),
    [refreshing, setRefreshing] = useState(false),
    [now, setNow] = useState(Date.now()),
    [selected, setSelected] = useState<string | null>(null),
    [query, setQuery] = useState(""),
    [detail, setDetail] = useState<DetailState | null>(null);
  const load = useCallback(async () => {
    try {
      const s = await rpc.call("status");
      setSnapshots(s.snapshots);
      setObservations(s.projectObservations ?? []);
      setRefreshing(s.refreshing);
      setError(s.configurationError);
      setNow(Date.now());
    } catch {
      setError("Не удалось получить статус плагина");
    }
  }, [rpc]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [load]);
  const rows: Row[] = (snapshots ?? []).flatMap((snapshot) =>
    (snapshot.data?.status.projects ?? []).map((project) => {
      const runs = (snapshot.data?.runs ?? []).filter(
        (r) => r.project === project.name,
      );
      return {
        key: `${snapshot.source.id}/${project.name}`,
        snapshot,
        project,
        runs,
        summary: observedSummary(
          observations.find(
            (o) =>
              o.sourceId === snapshot.source.id && o.project === project.name,
          ),
          workSummary(project.state, runs, project.local, now),
          now,
          runs.find(r=>r.phase==="Задачи")?.at,
        ),
      };
    }),
  );
  const active = selected ? rows.find((r) => r.key === selected) : undefined;
  const sourceId = active?.snapshot.source.id,
    projectName = active?.project.name;
  const [detailVersion, setDetailVersion] = useState(0);
  useRealtime("changed", () => {
    void load();
    setDetailVersion((v) => v + 1);
  });
  useEffect(() => {
    let alive = true;
    setDetail(null);
    setDetailKey(`${sourceId}/${projectName}`);
    if (!sourceId || !projectName) return;
    const fetch = async () => {
      try {
        const d = await rpc.call("project", { sourceId, project: projectName });
        if (alive) {
          setDetail(d);
          setDetailKey(`${sourceId}/${projectName}`);
        }
      } catch {
        if (alive)
          setDetail({
            data: null,
            error: "Не удалось загрузить карточку проекта",
            loading: false,
          });
      }
    };
    void fetch();
    const timer = setInterval(() => void fetch(), 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [rpc, sourceId, projectName, detailVersion]);
  async function refresh() {
    setRefreshing(true);
    try {
      await rpc.call("refresh");
      await load();
    } catch {
      setError("Не удалось запустить обновление");
      setRefreshing(false);
    }
  }
  async function refreshProject() {
    if (!sourceId || !projectName) return;
    setDetail((d) => ({
      ...d,
      data: d?.data ?? null,
      error: null,
      loading: true,
    }));
    try {
      await rpc.call("project", {
        sourceId,
        project: projectName,
        refresh: true,
      });
      setDetailVersion((v) => v + 1);
    } catch {
      setDetail({
        data: null,
        error: "Не удалось обновить проект",
        loading: false,
      });
    }
  }
  return (
    <div className="h-full overflow-y-auto bg-background">
      <main className="mx-auto max-w-7xl p-4 md:p-6 space-y-5">
        <header className="flex items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Автопилот</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Что происходит в проектах и где нужно вмешаться
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => void refresh()}
            disabled={refreshing}
          >
            {refreshing ? "Обновляется…" : "Обновить сводку"}
          </Button>
        </header>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        {snapshots === null ? (
          <p>Загрузка…</p>
        ) : snapshots.length === 0 ? (
          <Section title="Добавь источник автопилота">
            <Empty>
              В настройках плагина укажи хост BB и пути к oxi-tr и его данным.
            </Empty>
          </Section>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Metric value={String(rows.length)} label="Проектов в сводке" />
              <Metric
                value={String(
                  rows.filter(
                    (r) =>
                      r.summary.tone === "warning" ||
                      r.summary.tone === "error",
                  ).length,
                )}
                label="Требуют проверки"
              />
              <Metric
                value={String(
                  rows.filter(
                    (r) =>
                      r.project.state === "paused" ||
                      r.project.state === "disabled",
                  ).length,
                )}
                label="На паузе или выключены"
              />
              <Metric
                value={String(
                  snapshots.filter(
                    (s) =>
                      s.error ||
                      !s.updatedAt ||
                      now - Date.parse(s.updatedAt) > 300_000,
                  ).length,
                )}
                label="Источников с проблемами"
              />
            </div>
            {snapshots
              .filter(
                (s) =>
                  s.error ||
                  !s.data ||
                  !s.updatedAt ||
                  now - Date.parse(s.updatedAt) > 300_000,
              )
              .map((s) => (
                <p key={s.source.id} className="text-sm text-destructive">
                  {s.source.label}:{" "}
                  {s.error || "данные отсутствуют или устарели"} ·{" "}
                  {date(s.updatedAt)}
                </p>
              ))}
            <section
              aria-label="Проекты"
              className="rounded-lg border border-border overflow-hidden"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-border">
                <h2 className="text-sm font-semibold">
                  Проекты{" "}
                  <span className="font-normal text-muted-foreground">
                    · выбери строку, чтобы увидеть работу ниже
                  </span>
                </h2>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Найти проект"
                  placeholder="Найти проект…"
                  className="rounded-md border border-input bg-background px-3 py-1.5 text-sm w-48"
                />
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface-recessed text-xs text-muted-foreground">
                    <tr>
                      {[
                        "Проект / хост",
                        "Статус работы",
                        "Последний отчёт",
                        "Задачи GitHub",
                        "PR автопилота",
                      ].map((x) => (
                        <th key={x} className="px-4 py-2 font-medium">
                          {x}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows
                      .filter((r) =>
                        r.project.name
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .map((row) => (
                        <Fragment key={row.key}>
                        <tr
                          className={`border-t border-border cursor-pointer hover:bg-surface-recessed ${active?.key === row.key ? "bg-surface-recessed" : ""}`}
                          onClick={() => selectProject(row.key)}
                        >
                          <td className="px-4 py-3">
                            <button
                              aria-pressed={active?.key === row.key}
                              onClick={(event) => {
                                event.stopPropagation();
                                selectProject(row.key);
                              }}
                              className="text-left font-medium hover:underline"
                            >
                              {row.project.name}
                            </button>
                            <p className="text-xs text-muted-foreground mt-1">
                              {row.project.host}
                            </p>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded-md px-2 py-1 text-xs ${tones[row.summary.tone]}`}
                            >
                              {row.summary.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                            {row.runs[0]?.at
                              ? ago(row.runs[0].at, now)
                              : "Проверка: " +
                                ago(
                                  observations.find(
                                    (o) =>
                                      o.sourceId === row.snapshot.source.id &&
                                      o.project === row.project.name,
                                  )?.at ?? null,
                                  now,
                                )}
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {number(row.project.issues)}
                            {row.project.partial ? " *" : ""}
                            {row.project.countsError && <p className="text-xs text-muted-foreground" title={row.project.countsError}>{row.project.countsAt ? `Кэш · ${ago(row.project.countsAt, now)}` : "Обновляется"}</p>}
                          </td>
                          <td className="px-4 py-3 tabular-nums">
                            {row.project.autoPrs === null ||
                            row.project.devPrs === null
                              ? "—"
                              : row.project.autoPrs + row.project.devPrs}
                          </td>
                        </tr>
                        {active?.key===row.key&&<tr className="border-t border-border"><td colSpan={5} className="p-3"><div className="space-y-3"><div className="flex justify-end"><button className="text-xs text-muted-foreground hover:underline" onClick={e=>{e.stopPropagation();setSelected(null);}}>Закрыть проект</button></div><ProjectPanel row={active} detail={detailKey===active.key?detail:null} reload={()=>void refreshProject()} now={now} savePlan={async plan=>{await rpc.call("saveModelPlan",{sourceId:row.snapshot.source.id,project:row.project.name,plan,...(!row.project.local&&row.project.fleetRevision?{fleetRevision:row.project.fleetRevision}:{})});await load();}}/></div></td></tr>}
                        </Fragment>
                      ))}
                  </tbody>
                </table>
              </div>
            </section>
            <footer className="text-xs text-muted-foreground">
              Сводка обновляется каждые 2 минуты. Последние снимки:{" "}
              {snapshots
                .map((s) => `${s.source.label} — ${date(s.updatedAt)}`)
                .join(" · ")}
            </footer>
          </>
        )}
      </main>
    </div>
  );
}
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "autopilot",
    title: "Автопилот",
    icon: "ChartColumn",
    path: "autopilot",
    component: Dashboard,
  });
});
