import {useRpc} from "./rpc";
import { ProjectPrSections } from "./project-pr-sections";
import { ProblemList } from "./problem-list";
import { ExecutionSettings } from "./execution-settings";
import type {ModelPlan} from "./model-plan-editor";
import { Button } from "./components/ui/button";
import {
  number,
  date,
  readableTimes,
  ago,
  modes,
  Section,
  Empty,
  Metric,
  type Row,
  type DetailState,
} from "./view";
export function ProjectPanel({
  row,
  bbProjectId,
  detail,
  reload,
  now,
  savePlan,
}: {
  row: Row;
  bbProjectId?: string;
  detail: DetailState | null;
  reload: () => void;
  now: number;
  savePlan?:(plan:ModelPlan)=>Promise<void>;
}) {
  const { project: p, snapshot: s, runs, summary } = row;
  const data = s.data!;
  const latestDev = runs.find((r) => r.phase === "Задачи");
  const latestReview = runs.find((r) => r.phase === "Ревью");
  const remoteSelection = detail?.data?.signals
    .flatMap((s) => s.rows)
    .find(
      (r) =>
        r.startsWith(`${p.name}:`) &&
        (r.includes("отбор") || r.includes("очередь")),
    );
  const tasks = runs.flatMap((r) =>
    r.tasks.map((t) => ({ ...t, at: r.at, engine: r.engine })),
  );
  const uniqueTasks = tasks.filter(
    (t, i) =>
      tasks.findIndex(
        (x) =>
          x.repo === t.repo &&
          x.issue === t.issue &&
          x.pipelineId === t.pipelineId,
      ) === i,
  );
  const repoPaths = new Set(
    runs.flatMap((r) => [...r.repos, ...r.tasks.map((t) => t.repo)]),
  );
  const pipelineIds = new Set(tasks.map((t) => t.pipelineId).filter(Boolean));
  const pipelines = data.pipelines.filter(
    (x) => pipelineIds.has(x.id) || repoPaths.has(x.repo),
  );
  const alerts = data.status.alerts.filter((a) => a.startsWith(`${p.name}:`));
  return (
    <article
      aria-label={`Проект ${p.name}`}
      className="space-y-4 border-t border-border pt-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">
            Выбранный проект · {p.host}
          </p>
          <h2 className="text-2xl font-semibold mt-1">{p.name}</h2>
          <p className="text-sm mt-2">
            {summary.label}{" "}
            <span className="text-muted-foreground">· {readableTimes(summary.reason)}</span>
          </p>
        </div>
        <Button variant="outline" onClick={reload} disabled={detail?.loading}>
          {detail?.loading ? "Проверяем хост и GitHub…" : "Проверить проект"}
        </Button>
      </header>
      <section className="rounded-lg border border-border p-3 space-y-1 text-sm">
        <p>Сводка источника: {s.updatedAt ? date(s.updatedAt) : 'ещё не получена'}{s.error ? ' · ошибка обновления, показан предыдущий снимок' : ''}</p>
        {s.error&&<p role="alert">{s.error}</p>}
        <p>Диагностика проекта: {detail?.data?.observedAt ? date(detail.data.observedAt) : 'ещё не получена'}{detail?.data&&now-Date.parse(detail.data.observedAt)>300_000?' · устарела':''}{detail?.loading?' · обновляется':''}</p>
        {!p.local&&<p>Исполнение на {p.host}. Локальные отчёты Mac не показывают его текущие задачи; смотри результат проверки хоста ниже.</p>}
        {p.issues===null&&p.autoPrs===null&&p.devPrs===null&&<p className="text-muted-foreground">Счётчики GitHub загружаются отдельно. «—» означает нет данных, а не отсутствие задач или PR.</p>}
      </section>
      <p className="text-xs text-muted-foreground">GitHub: {p.countsAt?date(p.countsAt):"ожидаем первый результат"}{p.countsError?` · ${p.countsError}`:""}</p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric
          value={number(p.issues)}
          label="Открытые задачи в репозиториях"
        />
        <Metric value={number(p.autoPrs)} label="PR с исправлениями ревью" />
        <Metric value={number(p.devPrs)} label="PR по задачам" />
        <Metric
          value={latestDev ? number(latestDev.launched) : "—"}
          label="Запущено в последнем отборе"
        />
      </div>
      <ProjectPrSections detail={detail} sourceId={s.source.id} project={p.name} bbProjectId={bbProjectId} />
      {p.partial && (
        <p className="text-sm text-muted-foreground">
          Счётчики получены частично. Открытые задачи не равны очереди
          автопилота.
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Последний отбор задач">
          {latestDev ? (
            <>
              <p className="text-xs text-muted-foreground">
                {date(latestDev.at)} · {ago(latestDev.at, now)} ·{" "}
                {latestDev.engine || "движок не указан"}
              </p>
              <p className="text-sm">
                Кандидатов: <b>{number(latestDev.candidates)}</b> · Запущено:{" "}
                <b>{number(latestDev.launched)}</b> ·{" "}
                {latestDev.scanComplete
                  ? "Обход завершён"
                  : "Полнота обхода не подтверждена"}
              </p>
              {latestDev.reason && (
                <p className="text-sm">{latestDev.reason}</p>
              )}
              {latestDev.filters.length > 0 && (
                <ul className="text-sm space-y-1">
                  {latestDev.filters.map((f, i) => (
                    <li key={i}>• {f}</li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <Empty>
              {(remoteSelection ? readableTimes(remoteSelection) : null) ||
                (p.local
                  ? "Отчёт об отборе задач не найден."
                  : "Отбор выполняется на другом хосте. Его свежая диагностика появится в блоке ниже.")}
            </Empty>
          )}
        </Section>
        <Section title="Последний проход ревью">
          {latestReview ? (
            <>
              <p className="text-xs text-muted-foreground">
                {date(latestReview.at)} · {ago(latestReview.at, now)} ·{" "}
                {latestReview.engine || "движок не указан"}
              </p>
              {latestReview.reason && (
                <p className="text-sm">{latestReview.reason}</p>
              )}
              <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">
                {latestReview.summary || "Подробный результат не записан"}
              </p>
            </>
          ) : (
            <Empty>Свежего отчёта ревью из исполняющего хоста пока нет.</Empty>
          )}
        </Section>
      </div>
      <ProblemList key={`${s.source.id}/${p.name}`} row={row} detail={detail} bbProjectId={bbProjectId} />
      <Section title="Задачи и результаты запусков">
        {uniqueTasks.length ? (
          <div className="space-y-3">
            {uniqueTasks.map((t, i) => (
              <div
                key={i}
                className="border-b border-border pb-3 last:border-0"
              >
                <div className="flex justify-between gap-3">
                  <p className="text-sm font-medium">
                    #{t.issue ?? "—"} · {t.title || "Задача без названия"}
                  </p>
                  <span className="text-xs rounded bg-surface-recessed px-2 py-1">
                    {t.status}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {t.repo.split("/").pop()} · {t.engine} · {date(t.at)}
                </p>
                {t.reason && <p className="text-sm mt-2">{t.reason}</p>}
                {t.pipelineId && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Прогон {t.pipelineId}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            В загруженных отчётах нет запусков задач. Это не означает, что в
            проекте нет открытых issues.
          </Empty>
        )}
        {pipelines.length > 0 && (
          <div className="space-y-2">
            {pipelines.map((x) => (
              <p key={x.id} className="text-sm">
                {x.id} · {x.status} · {x.engine} · {date(x.updatedAt)}
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              Состояния прогонов записаны task-runner; актуальность процесса
              отдельно не проверялась.
            </p>
          </div>
        )}
      </Section>
      <Section title="История циклов на подключённом хосте">
        {runs.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="pb-2">Когда</th>
                  <th>Работа</th>
                  <th>Движок</th>
                  <th>Результат</th>
                </tr>
              </thead>
              <tbody>
                {runs.slice(0, 20).map((r, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="py-2 whitespace-nowrap pr-3">
                      {date(r.at)}
                    </td>
                    <td className="pr-3">{r.phase}</td>
                    <td className="pr-3">{r.engine || "—"}</td>
                    <td className="py-2">
                      {r.reason ||
                        (r.phase === "Задачи"
                          ? `Кандидатов: ${number(r.candidates)}, запущено: ${number(r.launched)}`
                          : r.summary
                              .split("\n")
                              .find((l) => l.includes("итог:")) ||
                            "Отчёт ревью сохранён")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {p.local ? "В загруженной истории этого проекта нет отчётов за выбранный период." : "История с исполняющего хоста ещё не подключена; локальную историю другого хоста здесь не подставляем."}
          </Empty>
        )}
      </Section>
      {detail?.data?.activity && p.local && (
        <Section title="Результаты за последние 7 дней">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric
              value={number(detail.data.activity.fixed)}
              label="Исправления ревью"
            />
            <Metric
              value={number(detail.data.activity.followups)}
              label="Follow-up PR"
            />
            <Metric
              value={number(detail.data.activity.failed)}
              label="Неуспешные попытки"
            />
            <Metric
              value={number(detail.data.activity.budgetStops)}
              label="Остановки по бюджету"
            />
          </div>
          <Empty>
            История попыток на подключённом хосте. Это не число уникальных
            закрытых задач.
          </Empty>
        </Section>
      )}
      <ExecutionSettings row={row} onSave={savePlan} />
    </article>
  );
}
