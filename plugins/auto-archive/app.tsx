import { useEffect, useRef, useState } from "react";
import { definePluginApp, useSdk } from "@get-bb/plugin-sdk/app";

export function PermanentThread({ threadId }: { threadId: string }) {
  const sdk = useSdk();
  const generation = useRef(0);
  const saving = useRef(false);
  const [permanent, setPermanent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      if (saving.current) return;
      const request = ++generation.current;
      try {
        const metadata = await sdk.threads.getPluginMetadata({ threadId, signal: controller.signal });
        if (!controller.signal.aborted && request === generation.current) { setPermanent(metadata.permanent === true); setError(false); }
      } catch { if (!controller.signal.aborted && request === generation.current) setError(true); }
    };
    setPermanent(null);
    void load();
    window.addEventListener("focus", load);
    return () => { controller.abort(); window.removeEventListener("focus", load); };
  }, [sdk, threadId]);
  return <label style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 28,
    fontSize: 12, whiteSpace: "nowrap", color: error ? "var(--destructive)" : "inherit" }}
    title={error ? "Не удалось сохранить или прочитать отметку. Повторите попытку." :
      "Постоянный тред"}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 3 21 8l-4 1-4 4-1 5-3-3-5 5 5-5-3-3 5-1 4-4z" />
    </svg>
    <input type="checkbox" aria-label="Постоянный тред" checked={permanent === true}
      disabled={permanent === null || busy} onChange={async (event) => {
        const value = event.target.checked;
        saving.current = true; generation.current++;
        setBusy(true); setError(false);
        try {
          await sdk.threads.updatePluginMetadata({ threadId, set: { permanent: value } });
          setPermanent(value);
        } catch { setError(true); }
        finally { saving.current = false; setBusy(false); }
      }} />
    {error ? " ⚠" : ""}
  </label>;
}

export default definePluginApp(app => {
  app.slots.experimental_threadHeaderAction({
    id: "permanent", title: "Постоянный тред",
    component: ({ threadId }) => <PermanentThread key={threadId} threadId={threadId} />,
  });
});
