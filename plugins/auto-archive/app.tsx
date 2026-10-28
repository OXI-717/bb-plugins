import { useEffect, useState } from "react";
import { definePluginApp, useSdk } from "@get-bb/plugin-sdk/app";

function PermanentThread({ threadId, compact }: { threadId: string; compact: boolean }) {
  const sdk = useSdk();
  const [permanent, setPermanent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      try {
        const metadata = await sdk.threads.getPluginMetadata({ threadId, signal: controller.signal });
        if (!controller.signal.aborted) { setPermanent(metadata.permanent === true); setError(false); }
      } catch { if (!controller.signal.aborted) setError(true); }
    };
    setPermanent(null);
    void load();
    window.addEventListener("focus", load);
    return () => { controller.abort(); window.removeEventListener("focus", load); };
  }, [sdk, threadId]);
  return <label style={{ display: "inline-flex", alignItems: "center", gap: 5, height: 28,
    fontSize: 12, whiteSpace: "nowrap", color: error ? "var(--destructive)" : "inherit" }}
    title={error ? "Не удалось сохранить или прочитать отметку. Повторите попытку." :
      "Auto Archive сохраняет этот тред и его предков. Закрепление и 📌 также защищают тред."}>
    <input type="checkbox" aria-label="Постоянный тред" checked={permanent === true}
      disabled={permanent === null || busy} onChange={async (event) => {
        const value = event.target.checked;
        setBusy(true); setError(false);
        try {
          await sdk.threads.updatePluginMetadata({ threadId, set: { permanent: value } });
          setPermanent(value);
        } catch { setError(true); }
        finally { setBusy(false); }
      }} />
    {!compact && "Постоянный тред"}{error ? " ⚠" : ""}
  </label>;
}

export default definePluginApp(app => {
  app.slots.experimental_threadHeaderAction({
    id: "permanent", title: "Постоянный тред",
    component: ({ threadId, isCompactViewport }) => <PermanentThread key={threadId} threadId={threadId} compact={isCompactViewport} />,
  });
});
