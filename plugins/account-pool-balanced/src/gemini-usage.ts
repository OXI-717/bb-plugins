import { z } from "zod";

const displayText = z.string().min(1).max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+/-]*$/u);

const summaryWindowSchema = z.object({
  kind: z.enum(["five-hour", "weekly"]),
  usedPercent: z.number().min(0).max(100),
  resetAt: z.number().int().nonnegative().nullable(),
}).strict();

export const geminiUsageSchema = z.object({
  observedAt: z.number().int().nonnegative(),
  plan: z.object({ id: displayText, name: displayText.nullable() }).strict().nullable(),
  // Preserve the provider's int64 string without rounding or inventing a limit.
  credits: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).nullable(),
  windows: z.array(summaryWindowSchema).max(2).optional(),
  models: z.array(z.object({
    modelId: displayText,
    tokenType: z.enum(["REQUESTS", "WTUS"]).nullable(),
    usedPercent: z.number().min(0).max(100),
    resetAt: z.number().int().nonnegative().nullable(),
  }).strict()).max(64),
}).strict();

export type GeminiUsage = z.infer<typeof geminiUsageSchema>;

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function safeText(value: unknown): string | null {
  const parsed = displayText.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type SummaryWindow = z.infer<typeof summaryWindowSchema>;

export function geminiSummaryWindows(payload: unknown): SummaryWindow[] {
  const root = object(payload);
  const summary = object(root.response ?? root);
  if (root.error != null || summary.error != null || root.success === false || summary.success === false ||
      !Array.isArray(summary.groups) || summary.groups.length > 8) return [];

  const windows = new Map<SummaryWindow["kind"], SummaryWindow | null>();
  for (const group of summary.groups) {
    const { buckets, displayName } = object(group);
    if (displayName === "Gemini 4 Argon") continue;
    if (!Array.isArray(buckets) || buckets.length > 16) return [];
    for (const raw of buckets) {
      const bucket = object(raw);
      const kind = bucket.bucketId === "gemini-5h" ? "five-hour"
        : bucket.bucketId === "gemini-weekly" ? "weekly" : null;
      if (kind === null) continue;
      const fraction = bucket.remainingFraction;
      if (windows.has(kind) ||
          (bucket.disabled !== undefined && bucket.disabled !== false) ||
          (bucket.window !== undefined && bucket.window !== (kind === "weekly" ? "weekly" : "5h")) ||
          typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
        windows.set(kind, null);
        continue;
      }
      const reset = typeof bucket.resetTime === "string" ? Date.parse(bucket.resetTime) : NaN;
      windows.set(kind, { kind, usedPercent: (1 - fraction) * 100,
        resetAt: Number.isFinite(reset) && reset >= 0 ? reset : null });
    }
  }
  return [...windows.values()].filter((window): window is SummaryWindow => window !== null);
}

export function geminiSummaryRows(usage: GeminiUsage | undefined, now: number) {
  return (usage?.windows ?? [])
    .filter(window => window.resetAt === null || window.resetAt > now)
    .map(window => ({ ...window, label: window.kind === "weekly" ? "Gemini · 7d" : "Gemini · 5h" }));
}

export function geminiUsageObservation(
  payload: unknown,
  enrichment: unknown,
  observedAt: number,
): GeminiUsage {
  const metadata = object(enrichment);
  const tier = object(metadata.paidTier ?? metadata.currentTier);
  const id = safeText(tier.id) ?? safeText(metadata.g1Tier);
  const credits = Array.isArray(tier.availableCredits)
    ? tier.availableCredits.map(object).filter(credit => credit.creditType === "GOOGLE_ONE_AI")
    : [];
  const amount = credits.length === 1 ? credits[0]?.creditAmount : null;
  const parsedCredit = geminiUsageSchema.shape.credits.safeParse(amount);
  const buckets = object(payload).buckets;
  const models: GeminiUsage["models"] = [];
  if (Array.isArray(buckets)) {
    for (const value of buckets.slice(0, 64)) {
      const bucket = object(value);
      const modelId = safeText(bucket.modelId);
      const fraction = bucket.remainingFraction;
      if (modelId === null || !modelId.startsWith("gemini-") ||
          typeof fraction !== "number" || !Number.isFinite(fraction) ||
          fraction < 0 || fraction > 1) continue;
      const reset = typeof bucket.resetTime === "string" ? Date.parse(bucket.resetTime) : NaN;
      models.push({
        modelId,
        tokenType: bucket.tokenType === "REQUESTS" || bucket.tokenType === "WTUS"
          ? bucket.tokenType : null,
        usedPercent: (1 - fraction) * 100,
        resetAt: Number.isFinite(reset) && reset >= 0 ? reset : null,
      });
    }
  }
  return {
    observedAt,
    plan: id === null ? null : { id, name: safeText(tier.name) },
    credits: parsedCredit.success ? parsedCredit.data : null,
    models,
  };
}

export function geminiPlanLabel(usage: GeminiUsage): string | null {
  return usage.plan?.name ?? usage.plan?.id ?? null;
}

export function geminiCreditLabel(usage: GeminiUsage): string | null {
  return usage.credits === null ? null : `Google One AI credits: ${usage.credits}`;
}

// Equal reports are grouped only for display; equality does not establish a shared allowance.
export function geminiUsageGroups(models: GeminiUsage["models"]) {
  const groups: Array<{id: string; label: string; usedPercent: number; resetAt: number | null; model: string | null; reports: GeminiUsage["models"]}> = [];
  const matching = new Map<string, number>();
  for (const [index, report] of models.entries()) {
    const key = report.tokenType === null ? null : JSON.stringify([report.tokenType, report.usedPercent, report.resetAt]);
    const previous = key === null ? undefined : matching.get(key);
    if (previous !== undefined) {
      const group = groups[previous]!;
      group.reports.push(report);
      group.label = `${group.reports.length} matching reports · ${report.tokenType}`;
      group.model = null;
    } else {
      if (key !== null) matching.set(key, groups.length);
      groups.push({id: `gemini:${report.modelId}:${report.tokenType ?? 'quota'}:${index}`,
        label: `${report.modelId}${report.tokenType ? ` · ${report.tokenType}` : ''}`,
        usedPercent: report.usedPercent, resetAt: report.resetAt, model: report.modelId, reports: [report]});
    }
  }
  return groups;
}
