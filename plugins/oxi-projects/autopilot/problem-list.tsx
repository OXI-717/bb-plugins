import {isFreshProjectDetail,freshProjectSignals} from "./work";
import {ProjectAnalysis} from "./project-analysis";
import {WorkActions} from '../work-actions';
import {useRpc} from "./rpc";
import { useEffect, useState } from "react";
import {  useRealtime, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./contract";
import type { Link } from "./dispatch";
import { presentProblem, problemContext } from "./problems";
import { Button } from "./components/ui/button";
import { readableTimes, date, type Row, type DetailState } from "./view";
const statusLabel = (status: string) =>
  ({
    draft: "Ждёт выбора модели и запуска",
    active: "Работает",
    starting: "Запускается",
    pending: "Ожидает запуска",
    idle: "Ход завершён",
    error: "Ошибка агента",
    archived: "Архив",
    created: "Создан",
    "send-failed": "Не запущен",
    unavailable: "Статус недоступен",
  })[status] ?? status;
export function ProblemList({
  row,
  bbProjectId,
  detail,
}: {
  row: Row;
  bbProjectId?:string;
  detail: DetailState | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [links, setLinks] = useState<Link[]>([]),
    [revision, setRevision] = useState(0),
    [pending, setPending] = useState<string | null>(null),
    [message, setMessage] = useState<{ problem: string; text: string } | null>(
      null,
    );
  const sourceId = row.snapshot.source.id,
    project = row.project.name;
  useRealtime("changed", () => setRevision((v) => v + 1));
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const value = await rpc.call("links", { sourceId, project });
        if (alive) setLinks(value);
      } catch {}
    };
    void load();
    return () => {
      alive = false;
    };
  }, [rpc, sourceId, project, revision]);
  const alerts =
    row.snapshot.data?.status.alerts.filter((a) =>
      a.startsWith(`${project}:`),
    ) ?? [];
  const freshDetail=isFreshProjectDetail(detail?.data)?{...detail!.data!,signals:freshProjectSignals(detail!.data)}:null;
  const observations = [
    ...(row.project.engineControls?.error?[`Паузы движков на ${row.project.host}: ${row.project.engineControls.error}`]:[]),
    ...(row.project.countsError?[`Счётчики: ${row.project.countsError}`]:[]),
    ...alerts,
    ...(freshDetail?.signals.flatMap((s) => s.rows) ?? []),
    ...(freshDetail?.errors ?? []),
  ];
  const unique = [...new Set(observations)];
  async function copy(problem: string) {
    try {
      await navigator.clipboard.writeText(
        problemContext(row.snapshot, project, problem, freshDetail),
      );
      setMessage({ problem, text: "Контекст скопирован" });
    } catch {
      setMessage({
        problem,
        text: "Не удалось скопировать. Проверь разрешение браузера на буфер обмена.",
      });
    }
  }
  async function dispatch(problem: string) {
    if (pending) return;
    setPending(problem);
    setMessage(null);
    try {
      navigate.toCompose({initialPrompt:problemContext(row.snapshot, project, problem, freshDetail),focusPrompt:true});
      setMessage({problem,text:"Контекст открыт в редакторе. Проверь проект и модель, затем отправь вручную."});
    } catch (error) {
      setMessage({
        problem,
        text:
          error instanceof Error ? error.message : "Не удалось создать тред",
      });
    } finally {
      setPending(null);
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">Проблемы и следующие действия</h3>
        {detail?.data && (
          <span className="text-xs text-muted-foreground">
            Проверено {date(detail.data.observedAt)}
          </span>
        )}
      </div>
      {detail?.loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Проверяем хост и GitHub…
        </p>
      )}
      {detail?.error && (
        <p role="alert" className="text-sm text-destructive">
          {detail.error}
        </p>
      )}
      {unique.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Откроется черновик в редакторе BB. Выбери проект и модель перед отправкой.
        </p>
      )}
      {(unique.length>0 || row.summary?.tone==="error" || row.summary?.tone==="warning")&&<ProjectAnalysis key={`${sourceId}/${project}`} sourceId={sourceId} project={project} bbProjectId={bbProjectId}/>}
      {unique.map((raw) => {
        const problem = presentProblem(raw),
          linked = links.find((l) => l.problem === raw);
        return (
          <section
            key={raw}
            className={`rounded-lg border p-4 ${problem.kind === "error" ? "border-destructive/40" : "border-border"} bg-card`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{problem.title}</p>
                <p className="text-sm text-muted-foreground leading-relaxed mt-1">
                  {readableTimes(problem.description)}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {problem.kind === "error"
                  ? "Ошибка"
                  : problem.kind === "warning"
                    ? "Проверить"
                    : "Наблюдение"}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copy(raw)}
              >
                Скопировать
              </Button>
              {linked ? (
                <>
                  <Button
                    size="sm"
                    onClick={() => navigate.toThread(linked.threadId)}
                  >
                    Открыть тред
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {statusLabel(linked.status)}
                  </span>
                </>
              ) : null}
            </div>
            {message?.problem === raw && (
              <p role="status" className="text-xs mt-2">
                {message.text}
              </p>
            )}
            {linked?.error && message?.text !== linked.error && (
              <p className="text-xs text-destructive mt-2">{linked.error}</p>
            )}
          </section>
        );
      })}
      {!unique.length && !detail?.loading && (
        <p className="text-sm text-muted-foreground">
          Нет загруженных сигналов. Проверка проекта покажет доступные
          наблюдения.
        </p>
      )}
      {links.length > 0 && (
        <section className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-semibold mb-3">Связанные разборы</h3>
          <div className="space-y-2">
            {links.map((l) => (
              <div
                key={l.key}
                className="flex flex-wrap items-center justify-between gap-2"
              >
                <button
                  className="text-sm text-left hover:underline"
                  onClick={() => navigate.toThread(l.threadId)}
                >
                  {presentProblem(l.problem).title}
                </button>
                <span className="text-xs text-muted-foreground">
                  {statusLabel(l.status)} · {date(l.createdAt)}
                </span>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Завершённый ход агента ещё не означает, что проблема устранена.
          </p>
        </section>
      )}
    </div>
  );
}
