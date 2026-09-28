import { useState } from "react";
import { useRpc, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { catalogRpcContract } from "./src/catalog";
import { runLabel } from "./lib/operations";

export function RunResult({ taskKey, runId }: { taskKey: string; runId: string }) {
  const rpc = useRpc<typeof catalogRpcContract>();
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: string; output: string | null; error: string | null; threadId: string | null; truncated: boolean } | null>(null);
  async function load() {
    setOpen(true); setLoading(true); setError(null);
    try { setResult(await rpc.call("catalog_run_result", { key: taskKey, runId })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  }
  return <div>
    <button className="underline" onClick={() => open ? setOpen(false) : void load()} aria-expanded={open}>
      {open ? "Скрыть результат" : "Открыть результат"}
    </button>
    {open && <section aria-label="Результат выбранного запуска" className="mt-2 space-y-2 rounded border p-2">
      {loading ? <p role="status">Читаем результат из BB…</p> : error ? <p role="alert">{error} <button className="underline" onClick={() => void load()}>Повторить</button></p> : result && <>
        <p className="font-medium">{runLabel(result.status)}</p>
        {result.error && <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-destructive">{result.error}</pre>}
        {result.output ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words">{result.output}</pre> : <p>Текстовый вывод не сохранён.</p>}
        {result.threadId && <button className="underline" onClick={() => navigate.toThread(result.threadId!)}>Открыть тред этого запуска</button>}
        {result.truncated && <p>Показано начало длинного результата. Полный текст доступен в BB.</p>}
      </>}
    </section>}
  </div>;
}
