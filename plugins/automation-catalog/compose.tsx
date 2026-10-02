import {
  experimental_NewThreadComposer as NewThreadComposer,
  useRpc,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { Button } from "./components/ui/button";
import type { catalogRpcContract } from "./src/catalog";
export type ComposeIntent = { title: string; prompt: string; draftKey: string; taskKey?: string };
export function AutomationComposer({
  intent,
  onBack,
}: {
  intent: ComposeIntent;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof catalogRpcContract>();
  const navigate = useBbNavigate();
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(intent.title);
  const [context, setContext] = useState<{ parentThreadId: string; parentTitle: string; projectId: string } | null>(null);
  useEffect(() => {
    let active = true;
    rpc.call("catalog_compose_context", intent.taskKey ? { taskKey: intent.taskKey } : {}).then(
      value => { if (active) setContext(value); },
      cause => { if (active) setError(cause instanceof Error ? cause.message : String(cause)); },
    );
    return () => { active = false; };
  }, [rpc, intent.taskKey]);
  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 p-4">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Автоматизации
        </Button>
        <h1 className="mt-3 text-lg font-semibold">{intent.title}</h1>
        <label className="mt-3 block text-sm">Название обсуждения
          <input className="mt-1 block w-full rounded border bg-background p-2" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} />
        </label>
        {context && <p className="mt-2 text-sm">Обсуждение будет вложено в «{context.parentTitle}». <button className="underline" onClick={() => navigate.toThread(context.parentThreadId)}>Открыть родительский тред</button></p>}
        <p className="text-xs text-muted-foreground">
          Проверьте текст задачи, проект и модель. Агент запустится только
          после отправки запроса.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Не удалось начать настройку. Черновик сохранён. {error}
        </p>
      )}
      {!context && !error && <p role="status">Проверяем привязку обсуждения…</p>}
      {context && <NewThreadComposer
        key={intent.draftKey}
        draftKey={intent.draftKey}
        initialPrompt={intent.prompt}
        defaultProjectId={context.projectId}
        className="min-h-0 flex-1"
        onSubmit={async (request) => {
          setError(null);
          try {
            const result = await rpc.call("catalog_compose", { request, title: title.trim(), parentThreadId: context.parentThreadId, ...(intent.taskKey ? { taskKey: intent.taskKey } : {}) });
            navigate.toThread(result.threadId);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            throw cause;
          }
        }}
      />}
    </main>
  );
}
