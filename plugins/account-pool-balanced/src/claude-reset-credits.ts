import { z } from "zod";
import type { ResetCredits } from "./contracts.js";

// Read-only usage contract used by Claude Code's cedar_ember usage read.
// Redemption handles and event/account metadata are deliberately not retained.
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value))).nullish();
const statusSchema = z.object({
  cedar_ember: z.object({
    eligible: z.boolean(),
    grants: z.array(z.object({
      label: z.string().optional(),
      resets_left: z.number().int().nonnegative(),
      starts_at: timestamp,
      ends_at: timestamp,
      paused: z.boolean().optional(),
      usable_now: z.boolean().optional(),
      use_requires_limit: z.boolean().optional(),
      clears: z.array(z.string()).optional(),
    })),
  }),
});

export function claudeResetCredits(payload: unknown, now: number): ResetCredits | null {
  const parsed = statusSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.cedar_ember.eligible) return null;
  const credits = parsed.data.cedar_ember.grants
    .filter((grant) => grant.resets_left > 0 && !grant.paused &&
      (grant.starts_at == null || Date.parse(grant.starts_at) <= now) &&
      (grant.ends_at == null || Date.parse(grant.ends_at) > now))
    .map((grant) => ({
      title: grant.label || "Сброс лимитов Claude",
      expiresAt: grant.ends_at == null ? null : Date.parse(grant.ends_at),
      remaining: grant.resets_left,
      limitTypes: grant.clears ?? [],
      ...(grant.usable_now === undefined ? {} : { usableNow: grant.usable_now }),
      ...(grant.use_requires_limit === undefined ? {} : { requiresLimit: grant.use_requires_limit }),
    }));
  return {
    availableCount: credits.reduce((total, credit) => total + credit.remaining, 0),
    credits,
    observedAt: now,
  };
}
