import { z } from "zod";
const t = z.string().max(2000),
  n = z.number().finite().nullable();
export const taskSchema = z.object({
  issue: n,
  title: t,
  status: t,
  reason: t,
  repo: t,
  pipelineId: t,
});
export const runSchema = z.object({
  project: t,
  at: t,
  phase: t,
  engine: t,
  reason: t,
  candidates: n,
  launched: n,
  scanComplete: z.boolean(),
  reposExpected: n,
  filters: z.array(t).max(50),
  tasks: z.array(taskSchema).max(100),
  repos: z.array(t).max(100),
  summary: t,
});
export type Run = z.infer<typeof runSchema>;
export const detailSchema = z.object({
  project: t,
  observedAt: t,
  activity: z
    .object({
      lastCycle: t,
      fixed: n,
      followups: n,
      failed: n,
      errors: n,
      budgetStops: n,
    })
    .nullable(),
  signals: z
    .array(z.object({ host: t, at: t, rows: z.array(t).max(100) }))
    .max(20),
  prs: z
    .array(
      z.object({
        number: n,
        title: t,
        repo: t,
        state: t,
        kind: t,
        at: t,
        url: t.nullable(),
      }),
    )
    .max(100),
  errors: z.array(t).max(100),
});
export type ProjectDetail = z.infer<typeof detailSchema>;
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 2000) : "");
const num = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
export function normalizeRun(value: unknown): Run {
  const r = obj(value),
    trace = obj(r.decision_trace),
    repos = arr(r.repos).map(obj);
  return runSchema.parse({
    project: str(r.project),
    at: str(r.cycle_ts),
    phase: r.phase === "dev-sweep" ? "Задачи" : "Ревью",
    engine: str(r.engine) || str(trace.engine),
    reason: str(r.skipped_reason) || str(r.budget_reason),
    candidates: num(trace.candidates_seen),
    launched: num(trace.launched),
    scanComplete: trace.scan_complete === true,
    reposExpected: num(trace.repos_expected),
    filters: Object.entries(obj(trace.filtered))
      .slice(0, 50)
      .map(([k, v]) => `${k}: ${v}`.slice(0, 2000)),
    tasks: arr(r.results)
      .slice(0, 100)
      .map((v) => {
        const x = obj(v);
        return {
          issue: num(x.issue),
          title: str(x.title),
          status: str(x.status),
          reason: str(x.reason),
          repo: str(x.repo),
          pipelineId: str(x.pipeline_id),
        };
      }),
    repos: repos
      .map((x) => str(x.repo))
      .filter(Boolean)
      .slice(0, 100),
    summary: str(r.text),
  });
}
export function workSummary(
  state: string,
  runs: Run[],
  local: boolean,
  now = Date.now(),
): {
  label: string;
  reason: string;
  tone: "muted" | "warning" | "success" | "error";
} {
  if (state === "paused")
    return {
      label: "На паузе",
      reason: "Установлена остановка проекта",
      tone: "muted",
    };
  if (state === "disabled")
    return {
      label: "Выключен",
      reason: "Автопилот отключён в конфигурации",
      tone: "muted",
    };
  if (!local)
    return {
      label: "Нужна проверка хоста",
      reason: "Открой проект: запросим текущую диагностику fleet",
      tone: "warning",
    };
  const latest = runs[0];
  if (!latest)
    return {
      label: "Нет отчётов",
      reason: "Не найден отчёт о работе проекта",
      tone: "warning",
    };
  if (
    !Number.isFinite(Date.parse(latest.at)) ||
    now - Date.parse(latest.at) > 2 * 3600_000
  )
    return {
      label: "Давно нет отчёта",
      reason: "Последний результат устарел; текущая работа неизвестна",
      tone: "warning",
    };
  if (latest.reason)
    return {
      label: "Есть ограничение",
      reason: latest.reason,
      tone: "warning",
    };
  const dev = runs.find((r) => r.phase === "Задачи");
  if (dev && now - Date.parse(dev.at) <= 2 * 3600_000) {
    if (dev.reason)
      return {
        label: "Отбор приостановлен",
        reason: dev.reason,
        tone: "warning",
      };
    if (dev.tasks.some((t) => /fail|blocked|gave_up|parked/.test(t.status)))
      return {
        label: "Есть ошибки",
        reason: "В последнем запуске задач есть неуспешные результаты",
        tone: "error",
      };
    if ((dev.launched ?? 0) > 0)
      return {
        label: "Задачи запускались",
        reason: `Последний отбор: запущено ${dev.launched}; исходы ниже`,
        tone: "success",
      };
    if (
      dev.candidates === 0 &&
      dev.scanComplete &&
      (dev.reposExpected ?? 0) > 0 &&
      dev.filters.length === 0
    )
      return {
        label: "Нет подходящих задач",
        reason: "Последний отбор завершён: 0 кандидатов",
        tone: "muted",
      };
    if ((dev.candidates ?? 0) > 0)
      return {
        label: "Кандидаты не запущены",
        reason:
          dev.filters.join(" · ") ||
          `Кандидатов: ${dev.candidates}; причина запуска не записана`,
        tone: "warning",
      };
  }
  return {
    label: "Последний цикл завершён",
    reason: "Результат ревью и отбор задач — в карточке проекта",
    tone: "muted",
  };
}
export function normalizeDetail(
  raw: Record<string, unknown>,
  project: string,
): ProjectDetail {
  const a = arr(raw.activity)
      .map(obj)
      .find((x) => x.project === project),
    live = obj(raw.live);
  const prs = Array.isArray(live.prs)
    ? live.prs
    : arr(raw.prs).filter((v) => obj(v).project === project);
  return detailSchema.parse({
    project,
    observedAt: new Date().toISOString(),
    activity: a
      ? {
          lastCycle: str(a.last_cycle),
          fixed: num(a.fixed),
          followups: num(a.followups),
          failed: num(a.failed),
          errors: num(a.errors),
          budgetStops: num(a.budget_stops),
        }
      : null,
    signals: Object.entries(obj(raw.attention))
      .slice(0, 20)
      .map(([host, value]) => {
        const s = obj(value);
        return {
          host,
          at: str(s.observed_at),
          rows: arr(s.rows).map(str).slice(0, 100),
        };
      }),
    prs: prs
      .slice(-100)
      .reverse()
      .map((v) => {
        const p = obj(v);
        const url = str(p.url);
        return {
          number: num(p.number),
          title: str(p.title),
          repo: str(p.repo),
          state: str(p.state) || "В истории",
          kind: str(p.kind),
          at: str(p.updatedAt) || str(p.ts),
          url: /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(url)
            ? url
            : null,
        };
      }),
    errors: (prs.length>100?[`Список PR усечён: источник вернул ${prs.length}, показаны 100`]:[]).concat(arr(live.skipped_repos)
      .map((v) => `Не удалось проверить PR: ${str(v)}`)
      ).concat(arr(raw.fleet_warnings).map(str))
      .slice(0, 100),
  });
}

export function observedSummary(
  observation: { at: string; rows: string[]; datedRows?: {at:string;row:string}[] } | undefined,
  base: ReturnType<typeof workSummary>,
  now = Date.now(),
  latestSelectionAt?: string,
): ReturnType<typeof workSummary> {
  if (
    !observation ||
    now - Date.parse(observation.at) > 300_000 ||
    base.label === "На паузе" ||
    base.label === "Выключен"
  )
    return base;
  const blocker = observation.rows.find((r) => r.startsWith("Protection hold:") || r.startsWith("STOP.") || r.startsWith("STOP,"));
  if (blocker) return {
    label: blocker.startsWith("Protection hold:") ? "Остановлен защитой" : "Остановлен на хосте",
    reason: blocker,
    tone: "warning",
  };
  // Only a later selection can supersede selection evidence; preserve other signals.
  const rows = observation.rows.filter((row,index) => {
    if (!latestSelectionAt || !/последний отбор|результат отбора устарел|отбор отложен|очередь (?:пуста|неизвест)|отбор задач неизвестно/.test(row)) return true;
    const signal = observation.datedRows?.[index];
    const at = signal?.row === row ? signal.at : observation.at;
    return !(Date.parse(latestSelectionAt) > Date.parse(at));
  });
  const reason =
    rows.find(
      (r) =>
        r.includes("последний отбор") ||
        r.includes("результат отбора устарел") ||
        r.includes("отбор отложен") ||
        r.startsWith("STOP."),
    ) || rows[0];
  if (!reason) return base;
  if (reason.startsWith("STOP."))
    return { label: "Остановлен на хосте", reason, tone: "warning" };
  if (reason.includes("устарел") || reason.includes("неизвест"))
    return { label: "Нет свежего результата", reason, tone: "warning" };
  if (reason.includes("очередь пуста"))
    return { label: "Нет подходящих задач", reason, tone: "muted" };
  if (reason.includes("запущено 0") || reason.includes("отложен"))
    return { label: "Задачи не запущены", reason, tone: "warning" };
  return { label: "Есть отчёт хоста", reason, tone: "muted" };
}

export const PROJECT_DETAIL_FRESH_MS = 1_800_000;

export function isFreshProjectDetail(
  detail: { observedAt: string } | null | undefined,
  now = Date.now(),
): boolean {
  if (!detail) return false;
  const age = now - Date.parse(detail.observedAt);
  return Number.isFinite(age) && age >= -300_000 && age <= PROJECT_DETAIL_FRESH_MS;
}

export function freshProjectSignals(
  detail: Pick<ProjectDetail, "observedAt" | "signals"> | null | undefined,
  now = Date.now(),
): ProjectDetail["signals"] {
  if (!isFreshProjectDetail(detail, now)) return [];
  return detail!.signals.filter((signal) =>
    isFreshProjectDetail({ observedAt: signal.at }, now),
  );
}
