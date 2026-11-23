import type { PoolProvider } from "./contracts.js";

//: Which BB provider each pooled subscription shows up as on the usage surface. Kimi
//: serves two agent entries from one subscription, so the primary one stands for both.
export const USAGE_PROVIDER_IDS: Record<PoolProvider, string> = {
  claude: "claude-code",
  codex: "codex",
  kimi: "acp-opencode-kimi",
  zai: "acp-opencode-zai",
  "opencode-go": "acp-opencode-go",
  neuraldeep: "acp-opencode-neuraldeep",
  nvidia: "acp-opencode-nvidia",
  ifm: "acp-opencode-ifm",
  agy: "acp-agy",
  cursor: "acp-oxi-cursor",
  devin: "acp-devin",
  grok: "acp-grok",
  gemini: "acp-antigravity",
};
