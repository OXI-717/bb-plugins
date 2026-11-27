import type { ModelRules } from "./contracts.js";

export { MODEL_PATTERN, modelRulesSchema, type ModelRules } from "./contracts.js";

/** Specificity of a match: exact beats any prefix, a longer prefix beats a shorter one; -1 = no match. */
function specificity(pattern: string, model: string): number {
  if (!pattern.endsWith("*")) return pattern === model ? Number.MAX_SAFE_INTEGER : -1;
  const prefix = pattern.slice(0, -1);
  return model.startsWith(prefix) ? prefix.length : -1;
}

export type ModelRuleOutcome = {
  /** Accounts the rules keep off this model, with the reason. */
  excluded: Map<string, "model-rule-denied" | "model-rule-not-allowed" | "model-rule-pinned-elsewhere">;
  /** Accounts the model is pinned to (after exclusions). */
  pinned: string[];
  /** True when a pinned account lets other accounts take over. */
  fallback: boolean;
};

export function resolveModelRules(model: string, accounts: ReadonlyArray<{ id: string; modelRules?: ModelRules }>): ModelRuleOutcome {
  const excluded: ModelRuleOutcome["excluded"] = new Map();
  const pinned: string[] = [];
  let fallback = false;
  for (const account of accounts) {
    const rules = account.modelRules ?? [];
    if (rules.length === 0) continue;
    let best = -1;
    let verdict: "pin" | "allow" | "deny" | null = null;
    let bestFallback = false;
    for (const rule of rules) {
      const level = specificity(rule.pattern, model);
      if (level < 0) continue;
      // At equal specificity a deny wins, then a pin, then an allow.
      const rank = (mode: string | null) => mode === "deny" ? 2 : mode === "pin" ? 1 : 0;
      if (level > best || (level === best && rank(rule.mode) > rank(verdict))) {
        best = level; verdict = rule.mode; bestFallback = rule.mode === "pin" && rule.fallback === true;
      }
    }
    if (verdict === "deny") { excluded.set(account.id, "model-rule-denied"); continue; }
    if (verdict === null && rules.some(rule => rule.mode === "allow")) { excluded.set(account.id, "model-rule-not-allowed"); continue; }
    if (verdict === "pin") { pinned.push(account.id); fallback ||= bestFallback; }
  }
  if (pinned.length > 0) {
    for (const account of accounts) {
      if (!pinned.includes(account.id) && !excluded.has(account.id)) excluded.set(account.id, "model-rule-pinned-elsewhere");
    }
  }
  return { excluded, pinned, fallback };
}
