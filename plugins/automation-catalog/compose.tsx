import {
  experimental_NewThreadComposer as NewThreadComposer,
  useRpc,
  useBbNavigate,
} from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { Button } from "./components/ui/button";
import type { catalogRpcContract } from "./src/catalog";
export type ComposeIntent = { title: string; prompt: string; draftKey: string };
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
  return (
    <main className="mx-auto flex h-full w-full max-w-5xl flex-col gap-3 p-4">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← Automations
        </Button>
        <h1 className="mt-3 text-lg font-semibold">{intent.title}</h1>
        <p className="text-xs text-muted-foreground">
          Describe the task and schedule, choose the project and model, then
          send to start setup.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          Could not start setup. Your draft is preserved. {error}
        </p>
      )}
      <NewThreadComposer
        key={intent.draftKey}
        draftKey={intent.draftKey}
        initialPrompt={intent.prompt}
        className="min-h-0 flex-1"
        onSubmit={async (request) => {
          setError(null);
          try {
            const result = await rpc.call("catalog_compose", { request });
            navigate.toThread(result.threadId);
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            throw cause;
          }
        }}
      />
    </main>
  );
}
