import {geminiPlanLabel, geminiCreditLabel} from './gemini-usage.js';
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import type { AccountSummary, PoolProvider } from "./contracts.js";
import type { AccountPoolHub } from "./hub.js";
import {
  usageSourceRpcContract,
  usageListMethod,
  usageFetchMethod,
  type UsageResource,
} from "./usage-contract.js";

export function usageWindowLabel(
  minutes: number | null,
  fallback: string,
): string {
  if (minutes === 300) return "Five-hour limit";
  if (minutes === 1_440) return "Daily limit";
  if (minutes === 10_080) return "Weekly limit";
  if (minutes === 43_200) return "Monthly limit";
  if (minutes === null) return fallback;
  return minutes % 1_440 === 0
    ? `${minutes / 1_440} day limit`
    : `${minutes / 60} hour limit`;
}

export function usagePlanLabel(
  account: Pick<AccountSummary, "subscriptionType" | "rateLimitTier">,
): string | null {
  const maxMatch = (account.rateLimitTier ?? "").match(/max_(\d+)x/u);
  if (maxMatch) return `Max (${maxMatch[1]}x)`;
  const subscription = account.subscriptionType;
  return subscription
    ? subscription.charAt(0).toUpperCase() + subscription.slice(1)
    : null;
}

function accountKey(account: AccountSummary): string | null {
  return account.provider === "codex"
    ? account.codexAccountId
      ? `openai:chatgpt:${account.codexAccountId}`
      : null
    : account.accountUuid
      ? `anthropic:account:${account.accountUuid}`
      : null;
}

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

const USAGE_FALLBACK_LABELS: Record<PoolProvider, string> = {
  claude: "Claude Code",
  codex: "Codex",
  kimi: "Kimi For Coding",
  zai: "Z.ai Coding Plan",
  "opencode-go": "OpenCode Go",
  neuraldeep: "NeuralDeep",
  nvidia: "NVIDIA NIM",
  ifm: "IFM",
  agy: "Antigravity",
  cursor: "Cursor",
  devin: "Devin",
  grok: "Grok",
  gemini: "Gemini",
};

export function usageResourceLabel(
  account: Pick<AccountSummary, "provider" | "label" | "email">,
): string {
  const providerLabel = USAGE_FALLBACK_LABELS[account.provider];
  const customLabel = account.label.trim();
  const email = (account.email ?? "").trim();
  if (customLabel.startsWith(`${providerLabel} ·`)) return customLabel;
  const hasCustomLabel =
    customLabel !== "" &&
    customLabel !== providerLabel &&
    customLabel !== email;
  const identity =
    hasCustomLabel && email !== ""
      ? `${customLabel} (${email})`
      : hasCustomLabel
        ? customLabel
        : email;
  if (identity === "" || identity === providerLabel) return providerLabel;
  return `${providerLabel} · ${identity}`;
}

function isExpiredAuthorizationError(error: string | null): boolean {
  return (
    error !== null &&
    /^\[(?:OAUTH_REAUTH_REQUIRED|API_KEY_EXPIRED)\]/u.test(error)
  );
}

// Devin, NeuralDeep and Antigravity have no quota collector here. Do not
// advertise an unmeasurable resource as a failed collection; the account
// remains available for routing.
function reportsUsage(account: Pick<AccountSummary, "provider">): boolean {
  return account.provider !== "ifm" && account.provider !== "nvidia" && account.provider !== "devin" && account.provider !== "neuraldeep" && account.provider !== "agy";
}

export function registerUsageSource(
  bb: BbPluginApi,
  hub: AccountPoolHub,
  now?: () => number,
) {
  bb.rpc.register(
    usageSourceRpcContract,
    {
      async [usageListMethod]() {
        const { accounts } = await hub.status();
        return {
          label: "Account Pooler",
          resources: accounts.filter(reportsUsage).map((account) => ({
            id: account.id,
            accountKey: accountKey(account),
            providerId: USAGE_PROVIDER_IDS[account.provider],
            label: [usageResourceLabel(account), account.provider === 'gemini' && account.geminiUsage ? geminiCreditLabel(account.geminiUsage) : null].filter(Boolean).join(' · '),
            scope: { kind: "shared" as const },
          })),
        };
      },
      async [usageFetchMethod]({ resourceId, refresh }) {
        const account = (await hub.status()).accounts.find(account => account.id === resourceId);
        if (!account) throw new Error("Usage resource no longer exists.");
        if (!reportsUsage(account)) {
          throw new Error(`Quota reporting is not available for ${USAGE_FALLBACK_LABELS[account.provider]}.`);
        }
        await hub.assertNetworkAllowed(account.provider);
        try {
          await hub.refreshUsage(resourceId, refresh, true);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!isExpiredAuthorizationError(message)) throw error;
        }
        const { accounts: allAccounts } = await hub.status();
        const accounts = allAccounts.filter(
          (account) => account.id === resourceId && reportsUsage(account),
        );
        if (accounts.length === 0)
          throw new Error("Usage resource no longer exists.");
        const resources: UsageResource[] = accounts.map((account) => {
          const referenceNow = now ? now() : (account.observedAt ?? Date.now());
          const windows: Extract<
            UsageResource["usage"],
            { status: "ok" }
          >["windows"] = [];
          const add = (
            id: string,
            label: string,
            utilization: number | null,
            reset: number | null,
            model: string | null,
          ) => {
            if (utilization === null) return;
            if (reset !== null && reset <= referenceNow) return;
            windows.push({
              kind:
                label === "Five-hour limit"
                  ? "five-hour"
                  : label === "Daily limit"
                    ? "daily"
                    : label.startsWith("Weekly")
                      ? "weekly"
                      : "custom",
              id,
              label,
              usedPercent: Math.round(utilization * 100),
              resetsAt: reset === null ? null : new Date(reset).toISOString(),
              model,
              cost: null,
            });
          };
          const isGemini = account.provider === 'gemini';
          const gemini = isGemini ? account.geminiUsage : undefined;
          if (gemini) for (const [index, model] of gemini.models.entries()) {
            if (model.resetAt !== null && model.resetAt <= referenceNow) continue;
            windows.push({kind: 'custom', id: `gemini:${model.modelId}:${model.tokenType ?? 'quota'}:${index}`,
              label: `${model.modelId}${model.tokenType ? ` · ${model.tokenType}` : ''}`,
              usedPercent: model.usedPercent, resetsAt: model.resetAt === null ? null : new Date(model.resetAt).toISOString(), model: model.modelId, cost: null});
          }
          if (!isGemini && account.limitWindows.length > 0) {
            for (const window of account.limitWindows) {
              add(
                window.slot,
                usageWindowLabel(window.windowMinutes, window.slot),
                window.utilization,
                window.resetAt,
                null,
              );
            }
          }
          if(!isGemini && (account.limitWindows.length===0 || account.provider==='opencode-go')) {
            if(!account.limitWindows.some(window=>window.windowMinutes===300)) add(
              "five-hour",
              "Five-hour limit",
              account.fiveHourUtilization,
              account.fiveHourResetAt,
              null,
            );
            if(!account.limitWindows.some(window=>window.windowMinutes===10080)) add(
              "weekly",
              "Weekly limit",
              account.sevenDayUtilization,
              account.sevenDayResetAt,
              null,
            );
          }
          for (const [family, window] of Object.entries(account.familyWeekly)) {
            if (window !== null)
              add(
                `weekly:${family}`,
                `Weekly · ${family}`,
                window.utilization,
                window.resetAt,
                family,
              );
          }
          // Z.AI reports a plan name, not a Claude Max multiplier. Preserve
          // stored account metadata without interpreting an unrelated tier.
          const rateLimitTier = account.provider === "zai" ? null : account.rateLimitTier;
          const accountFields = {
            plan: isGemini ? (gemini?.plan ? {id: gemini.plan.id, multiplier: null} : null) : account.subscriptionType
              ? {
                  id: account.subscriptionType.toLowerCase(),
                  multiplier:
                    Number(rateLimitTier?.match(/max_(\d+)x/u)?.[1]) ||
                    null,
                }
              : null,
            accountEmail: null,
            planLabel: isGemini ? (gemini ? geminiPlanLabel(gemini) : null) : usagePlanLabel({ ...account, rateLimitTier }),
          };
          const expiredAuth = isExpiredAuthorizationError(account.error);
          const error = expiredAuth
            ? null
            : (account.error === null
                ? null
                : "Usage could not be collected for this account. Try refreshing usage.") ??
              (account.observedAt === null
                ? "Usage has not been observed for this account."
                : null);
          return {
            id: account.id,
            accountKey: accountKey(account),
            providerId: USAGE_PROVIDER_IDS[account.provider],
            label: account.label,
            scope: { kind: "shared" },
            observedAt: account.observedAt,
            usage: expiredAuth
              ? { status: "expired", ...accountFields }
              : error === null
                ? { status: "ok", ...accountFields, windows }
                : { status: "error", ...accountFields, message: error },
          };
        });
        const resource = resources[0]!;
        return {
          accountKey: resource.accountKey,
          observedAt: resource.observedAt,
          usage: resource.usage,
        };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Usage windows for Account Pooler's shared accounts, independent of routing settings and host-local credentials.",
    },
  );
}
