import { z } from "zod";

const displayText = z.string().min(1).max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()+/-]*$/u);

export const geminiUsageSchema = z.object({
  observedAt: z.number().int().nonnegative(),
  plan: z.object({ id: displayText, name: displayText.nullable() }).strict().nullable(),
  // Preserve the provider's int64 string without rounding or inventing a limit.
  credits: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u).nullable(),
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
