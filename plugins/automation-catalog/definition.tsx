import { useEffect, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import type { definitionSchema } from "./src/discovery";
import type { catalogRpcContract } from "./src/catalog";
import { Button } from "./components/ui/button";

export function AutomationDefinition({ taskKey, schedulerHost }: { taskKey: string; schedulerHost: string }) {
  const rpc = useRpc<typeof catalogRpcContract>();
  const navigate = useBbNavigate();
  const [value, setValue] = useState<z.infer<typeof definitionSchema> | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    let cancelled = false; setValue(null); setError(false);
    rpc.call("catalog_definition", { key: taskKey }).then(v => { if (!cancelled) setValue(v); }, () => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [rpc, taskKey, revision]);
  const link = `${window.location.origin}/plugins/automation-catalog/catalog/${encodeURIComponent(taskKey)}`;
  async function copy() {
    try { await navigator.clipboard.writeText(link); setCopied(true); setCopyFailed(false); }
    catch { setCopyFailed(true); }
  }
  return <section className="rounded-md border p-3 space-y-2" aria-label="Задание и целевой тред">
    <h3 className="text-sm font-medium">Задание и целевой тред</h3>
    <p className="text-sm">Хост расписания: {schedulerHost}</p>
    {error ? <p role="alert" className="text-sm">Не удалось прочитать действующую настройку BB. <button className="underline" onClick={() => setRevision(n => n + 1)}>Повторить</button></p> : !value ? <p role="status">Читаем задание из BB…</p> : <>
      <p className="text-sm">{value.note}</p>
      {value.targetThreadId && <p className="text-sm">Получатель: <button className="underline" onClick={() => navigate.toThread(value.targetThreadId!)}>{value.targetTitle || "Открыть целевой тред"}</button>{value.targetHost ? ` · Хост агента: ${value.targetHost}` : " · Хост агента не подтверждён"}</p>}
      {value.kind === "agent" && !value.targetThreadId && <p className="text-sm">Каждый запуск создаёт отдельный тред; ссылки доступны в истории запусков.</p>}
      {value.prompt && <details><summary className="cursor-pointer text-sm">Текст задания</summary><pre className="mt-2 whitespace-pre-wrap break-words text-xs max-h-72 overflow-y-auto">{value.prompt}</pre></details>}
      <a href={value.nativeUrl} className="text-sm underline">Открыть расписание в BB</a>
    </>}
    <div><Button variant="outline" size="sm" onClick={() => void copy()}>{copied ? "Ссылка скопирована" : "Скопировать ссылку на автоматизацию"}</Button></div>
    {copyFailed && <p className="text-xs">Не удалось скопировать автоматически: <a className="underline break-all" href={link}>{link}</a></p>}
  </section>;
}
