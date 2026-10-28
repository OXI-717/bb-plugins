import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc, useRealtime, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { catalogRpcContract } from "./src/catalog";
import type { AuditList, AuditRecord } from "./src/audit-types";
import { Button } from "./components/ui/button";
import { timestamp } from "./lib/operations";

export const outcomeLabels = { passed: "Проверка прошла", partial: "Проверено частично", failed: "Проверка не прошла", "not-run": "Выполнение не проверено" };
export const decisionLabels = { keep: "Оставить", disable: "Отключить", delete: "Удалить", replace: "Заменить", defer: "Отложить", delegate: "Передано исполнителю", undecided: "Решение не принято" };
function evidenceUrl(value: string) {
  if (value.startsWith("/plugins/")) return value;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function AuditCard({ record, presentInCatalog = true, onSelect }: { record: AuditRecord; presentInCatalog?: boolean; onSelect?: () => void }) {
  const navigate = useBbNavigate();
  return <article className="rounded-md border p-3 space-y-2 text-sm">
    <header className="flex flex-wrap justify-between gap-2">
      {onSelect ? <button className="font-semibold text-left underline" onClick={onSelect}>{record.task.name}</button> : <h4 className="font-semibold">{record.summary}</h4>}
      <span className="text-xs text-muted-foreground">{record.kind === "action" ? "Изменение настройки" : "Аудит"} · {timestamp(record.checkedAt)}</span>
    </header>
    {onSelect && <p>{record.summary}</p>}
    <p>{outcomeLabels[record.outcome]} · {decisionLabels[record.decision]}</p>
    {!presentInCatalog && <p className="text-xs text-muted-foreground">Карточка удалена из каталога. История сохранена.</p>}
    <dl className="space-y-2">
      <div><dt className="font-medium">Что проверено</dt><dd className="whitespace-pre-wrap break-words">{record.checks}</dd></div>
      {record.changes && <div><dt className="font-medium">Что изменено</dt><dd className="whitespace-pre-wrap break-words">{record.changes}</dd></div>}
      {record.remaining && <div><dt className="font-medium">Что осталось</dt><dd className="whitespace-pre-wrap break-words">{record.remaining}</dd></div>}
      {!!record.evidence.length && <div><dt className="font-medium">Подтверждения</dt><dd><ul className="list-disc pl-5">{record.evidence.map((value, index) => {
        const url = evidenceUrl(value);
        return <li key={index} className="break-words">{url ? <a href={url} target="_blank" rel="noreferrer" className="underline">{value}</a> : value}</li>;
      })}</ul></dd></div>}
    </dl>
    <footer className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>Записано: {timestamp(record.recordedAt)}</span>
      {record.authorThreadId && <Button size="sm" variant="outline" onClick={() => navigate.toThread(record.authorThreadId!)}>Открыть тред проверки</Button>}
    </footer>
  </article>;
}

export function AuditPanel({ taskKey, archive = false }: { taskKey?: string; archive?: boolean }) {
  const rpc = useRpc<typeof catalogRpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<AuditList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState({ outcome: "not-run" as AuditRecord["outcome"], decision: "undecided" as AuditRecord["decision"], summary: "", checks: "", changes: "", remaining: "", evidence: "" });
  function edit(update: (value: typeof form) => typeof form) { setRequestKey(crypto.randomUUID()); setForm(update); }
  const pageSize = archive ? 20 : 5;
  const generation = useRef(0);
  const load = useCallback(async (pageOffset = offset) => {
    const request = ++generation.current;
    try {
      const result = await rpc.call("catalog_audit_list", { ...(taskKey ? { key: taskKey } : {}), query, offset: pageOffset, limit: pageSize });
      if (request === generation.current) { setData(result); setError(null); }
    } catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); }
  }, [rpc, taskKey, query, offset, pageSize]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  useRealtime("automation-catalog", () => { void load(); });
  async function save() {
    if (!taskKey) return;
    setPending(true); setError(null);
    try {
      await rpc.call("catalog_audit_append", { ...form, key: taskKey, idempotencyKey: requestKey, evidence: form.evidence.split("\n").map(s => s.trim()).filter(Boolean) });
      setEditing(false); setRequestKey(crypto.randomUUID()); setOffset(0); await load(0);
      setForm({ outcome: "not-run", decision: "undecided", summary: "", checks: "", changes: "", remaining: "", evidence: "" });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  }
  return <section aria-label="История проверок и решений" className="space-y-3 rounded-md border p-3">
    <header className="flex flex-wrap justify-between gap-2">
      <h3 className="font-semibold">История проверок и решений</h3>
      <div className="flex flex-wrap gap-2">
        {!archive && <Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel(`catalog/audits/${taskKey}`)}>Открыть журнал задачи</Button>}
        {taskKey && <Button size="sm" variant="outline" onClick={() => setEditing(v => !v)} aria-expanded={editing}>Добавить запись</Button>}
      </div>
    </header>
    {archive && <label className="block text-sm">Поиск по задачам и записям<input className="mt-1 w-full rounded-md border bg-background p-2" value={query} onChange={e => { setQuery(e.target.value); setOffset(0); }} maxLength={300} /></label>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {editing && <form className="rounded-md border p-3" onSubmit={e => { e.preventDefault(); void save(); }}><fieldset disabled={pending} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">Результат проверки<select className="mt-1 w-full rounded-md border bg-background p-2" value={form.outcome} onChange={e => edit(f => ({ ...f, outcome: e.target.value as AuditRecord["outcome"] }))}>{Object.entries(outcomeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label className="text-sm">Решение<select className="mt-1 w-full rounded-md border bg-background p-2" value={form.decision} onChange={e => edit(f => ({ ...f, decision: e.target.value as AuditRecord["decision"] }))}>{Object.entries(decisionLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      </div>
      {([ ["summary", "Краткий итог", 2000], ["checks", "Что и как проверено", 4000], ["changes", "Что изменено", 4000], ["remaining", "Что осталось сделать", 4000], ["evidence", "Подтверждения — по одному на строку", 16000] ] as const).map(([key, label, maxLength]) => <label className="block text-sm" key={key}>{label}<textarea className="mt-1 min-h-20 w-full rounded-md border bg-background p-2" value={form[key]} required={key === "summary" || key === "checks"} maxLength={maxLength} onChange={e => edit(f => ({ ...f, [key]: e.target.value }))} /></label>)}
      <p className="text-xs text-muted-foreground">Предыдущие записи сохраняются. Уточнение или новое решение добавляйте отдельной записью.</p>
      <Button type="submit" size="sm" disabled={pending}>{pending ? "Сохраняем…" : "Сохранить запись"}</Button>
    </fieldset></form>}
    {data && !data.total && <p className="text-sm text-muted-foreground">Записей аудита пока нет. Это не подтверждение работоспособности.</p>}
    {data?.records.map(record => <AuditCard key={record.id} record={record} presentInCatalog={record.presentInCatalog} onSelect={!taskKey ? () => navigate.toPluginPanel(`catalog/audits/${record.key}`) : undefined} />)}
    {data && data.total > pageSize && <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={!offset} onClick={() => setOffset(v => Math.max(0, v - pageSize))}>Назад</Button>
      <span className="text-xs">{offset + 1}–{Math.min(offset + pageSize, data.total)} из {data.total}</span>
      <Button size="sm" variant="outline" disabled={offset + pageSize >= data.total} onClick={() => setOffset(v => v + pageSize)}>Дальше</Button>
    </div>}
  </section>;
}

export function AuditPage({ taskKey }: { taskKey?: string }) {
  const navigate = useBbNavigate();
  return <main className="mx-auto max-w-5xl space-y-4 p-4 h-full overflow-y-auto">
    <header className="flex flex-wrap justify-between gap-2"><h1 className="text-xl font-semibold">Журнал аудитов</h1><Button size="sm" variant="outline" onClick={() => navigate.toPluginPanel("catalog")}>К каталогу</Button></header>
    <p className="text-sm text-muted-foreground">Проверки, изменения и решения по автоматизациям. История остаётся доступной после удаления задачи.</p>
    <AuditPanel key={taskKey ?? "all"} taskKey={taskKey} archive />
  </main>;
}
