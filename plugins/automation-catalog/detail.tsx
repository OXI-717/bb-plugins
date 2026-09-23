import { useEffect, useState } from "react";
import { useRpc, useRealtime } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { catalogSchedule } from "./lib/catalog-schedule";
import type { CatalogTask, CatalogList, CatalogDetail } from "./src/catalog-types";
import type { catalogRpcContract } from "./src/catalog";
function date(value: number | null) {
  return value === null
    ? "Not reported by source"
    : new Date(value).toLocaleString();
}
function scopeLabel(scope: string) {
  return scope === "unknown"
    ? "Ownership not specified"
    : scope === "personal"
      ? "Personal"
      : "Team";
}
function stateLabel(task: Pick<CatalogTask, "state" | "history">) {
  if (task.state === "unknown")
    return task.history === "not-connected"
      ? "Live status not connected"
      : "Status not reported";
  return task.state[0].toUpperCase() + task.state.slice(1);
}
function resultLabel(status: string) {
  return status === "unknown"
    ? "Outcome not reported"
    : status[0].toUpperCase() + status.slice(1);
}
function lastResult(run: NonNullable<CatalogTask["lastRun"]>) {
  const timestamp = run.startedAt ?? run.finishedAt;
  return `Last result: ${resultLabel(run.status)}${timestamp === null ? " · Run time not reported" : ` · ${date(timestamp)}`}`;
}
function failure(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function SourceStatus({ source }: { source: CatalogList["sources"][number] }) {
  const stale =
    source.lastSuccessAt === null ||
    Date.now() - source.lastSuccessAt > source.staleAfterMs;
  return (
    <p className="text-sm text-muted-foreground">
      {source.name} ·{" "}
      {source.lastSuccessAt === null
        ? "Not synchronized yet"
        : `Last synchronized: ${date(source.lastSuccessAt)}`}
      {stale ? " · Stale" : ""}
      {source.error ? ` · ${source.error}` : ""}
    </p>
  );
}
export function CatalogDetailContent({ detail }: { detail: CatalogDetail }) {
  const { task, source, runs } = detail;
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">{task.name}</h2>
      <p className="text-sm text-muted-foreground">
        {task.scheduler === "bb"
          ? `Managed by ${source.name}`
          : "Managed outside BB"}{" "}
        · {scopeLabel(task.scope)}
        {task.owner ? ` · ${task.owner}` : ""}
        {task.team ? ` · ${task.team}` : ""}
      </p>
      <p>{task.description}</p>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        {Object.entries({
          Host: task.host,
          Scheduler: task.scheduler,
          Executor:
            task.executor === "Unknown"
              ? "Not specified by source"
              : task.executor,
          Schedule: catalogSchedule(task.schedule),
          "Live state": stateLabel(task),
          ...(task.declaredState
            ? { "Declared state": task.declaredState }
            : {}),
        }).map(([key, value]) => (
          <div key={key} className="min-w-0">
            <dt className="text-muted-foreground">{key}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <SourceStatus source={source} />
      {task.missing && (
        <p role="status">
          This task is missing from the latest source snapshot. Last known data
          is retained.
        </p>
      )}
      {task.url && (
        <a
          href={task.url}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Open source system
        </a>
      )}
      <h3 className="font-semibold">Execution history and source events</h3>
      {runs.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {task.history === "not-recorded"
            ? "History is not recorded by this source."
            : task.history === "not-connected"
              ? "Run history is not connected."
              : "No recorded runs received."}
        </p>
      )}
      {runs.map((run) => (
        <article
          key={run.id}
          className="min-w-0 space-y-1 rounded-md border p-3 text-sm"
        >
          <div className="font-medium">
            {run.evidence === "state-change"
              ? "Source state change"
              : resultLabel(run.status)}
          </div>
          <div>
            {run.evidence === "state-change" ? (
              <>Event time: {date(run.finishedAt)}</>
            ) : (
              <>
                Started: {date(run.startedAt)} · Finished:{" "}
                {run.finishedAt === null && run.status === "running"
                  ? "Still running"
                  : date(run.finishedAt)}
              </>
            )}
            {run.exitCode !== null ? ` · Exit: ${run.exitCode}` : ""}
          </div>
          {run.summary && (
            <pre className="whitespace-pre-wrap break-words font-sans">
              {run.summary}
            </pre>
          )}
          <details className="text-muted-foreground">
            <summary className="cursor-pointer">Run identifier</summary>
            <p className="break-all">{run.id}</p>
          </details>
        </article>
      ))}
      <details className="text-sm text-muted-foreground">
        <summary className="cursor-pointer">Source details</summary>
        <p className="break-all">{task.id}</p>
        {task.schedule && (
          <p className="whitespace-pre-wrap break-words">{task.schedule}</p>
        )}
      </details>
    </div>
  );
}
export function CatalogDetailView({
  taskKey,
  onBack,
}: {
  taskKey: string;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof catalogRpcContract>();
  const [detail, setDetail] = useState<CatalogDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  useRealtime("automation-catalog", () => setRevision((value) => value + 1));
  useEffect(() => {
    let active = true;
    setDetail(null);
    setError(null);
    rpc.call("catalog_detail", { key: taskKey, offset, limit: 25 }).then(
      (value) => {
        if (active) setDetail(value);
      },
      (reason: unknown) => {
        if (active) setError(failure(reason));
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, taskKey, offset, revision]);
  return (
    <div className="space-y-4 p-4">
      <Button variant="outline" onClick={onBack}>
        Back to automations
      </Button>
      {error && <p role="alert">{error}</p>}
      {detail && (
        <>
          <CatalogDetailContent detail={detail} />
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - 25))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              disabled={offset + 25 >= detail.total}
              onClick={() => setOffset(offset + 25)}
            >
              Next
            </Button>
          </div>
        </>
      )}
      {detail === null && error === null && <p>Loading history…</p>}
    </div>
  );
}
