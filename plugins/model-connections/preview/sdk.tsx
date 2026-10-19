import { useEffect } from "react";
import { classifyConnections } from "../catalog";
const hidden = new Set<string>();
const providers = [
  ["claude-code", "Claude Code"],
  ["acp-cursor", "Cursor"],
  ["codex", "Codex"],
  ["acp-oxi-cursor", "Cursor"],
  ["acp-opencode-kimi", "Kimi"],
  ["acp-opencode-zai", "Z.ai"],
  ["acp-opencode-go", "OpenCode Go"],
  ["acp-oxi-devin-pool", "Devin"],
  ["pi", "Pi"],
  ["acp-grok", "Grok Build"],
].map(([id, name]) => ({
  id,
  name,
  available: true,
  logoUrl: null,
  icon: "Toolbox",
}));
const snapshot = () => ({
  hostId: "host-example",
  hosts: [{ id: "host-example", name: "Рабочая машина" }],
  environmentId: "environment-example",
  projectId: "project-example",
  currentProviderId: "codex",
  poolAvailable: true,
  connections: classifyConnections(
    providers,
    new Map([
      ["claude-code", "ready"],
      ["codex", "ready"],
      ["acp-cursor", "ready"],
      ["pi", "not_installed"],
      ["acp-grok", "unauthenticated"],
    ]),
    {
      routing: {
        codex: true,
        claude: false,
        cursor: true,
        kimi: true,
        zai: true,
        "opencode-go": true,
        devin: true,
      },
      accounts: ["codex", "cursor", "kimi", "zai", "opencode-go", "devin"].map(
        (provider) => ({ provider, enabled: true }),
      ),
    },
    [...hidden],
    null,
  ),
});
const rpc = {
  call: async (method: string, input: Record<string, unknown>) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (method === "catalog") return snapshot();
    if (method === "visibility") {
      if (input.hidden) hidden.add(String(input.providerId));
      else hidden.delete(String(input.providerId));
      return { ok: true };
    }
    if (method === "apply") return { ok: true };
    throw Error("Preview only: no thread is created");
  },
};
export const defineRpcContract = (value: unknown) => value;
export const definePluginApp = (value: unknown) => value;
export const useRpc = () => rpc;
export const useBbNavigate = () => ({
  toThread: () => {},
  openThreadPanel: () => true,
});
export function experimental_Icon({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={className}>
      {name === "RefreshCw"
        ? "↻"
        : name === "Check"
          ? "✓"
          : name === "EyeOff"
            ? "⊖"
            : "⊕"}
    </span>
  );
}
export function experimental_ProviderIcon({
  className,
}: {
  className?: string;
}) {
  return (
    <span className={className} aria-hidden="true">
      ◇
    </span>
  );
}
export function experimental_ProviderModelPicker({
  value,
  onChange,
}: {
  value: { providerId: string; model: string; reasoningLevel: string };
  onChange: (value: unknown) => void;
}) {
  useEffect(() => {
    if (!value.model)
      onChange({ ...value, model: "model-example", reasoningLevel: "high" });
  }, [value, onChange]);
  return (
    <label>
      Модель{" "}
      <select
        value={value.model}
        onChange={(e) => onChange({ ...value, model: e.target.value })}
      >
        <option value="model-example">Основная модель</option>
        <option value="model-fast">Быстрая модель</option>
      </select>
    </label>
  );
}
export function experimental_NewThreadComposer() {
  return <p>Демонстрация формы. Реальные треды в preview не создаются.</p>;
}
