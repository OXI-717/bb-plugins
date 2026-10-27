import { z } from 'zod';
import type { AccountQuota } from './contracts.js';

const missing = z.enum(['missing', 'empty', 'invalid']);
const numeric = z.union([z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), missing]);
const boolean = z.union([z.boolean(), missing]);
// Fixed positions: used-percent, window-minutes, reset-at, reset-after-seconds, over-limit.
const slot = z.tuple([numeric, numeric, numeric, numeric, boolean]);
const state = z.enum(['present', 'absent', 'unknown']);
export const codexQuotaObservationSchema = z.object({
  primary: slot, secondary: slot,
  priorUsage: z.object({
    observedAt: z.number().finite(), ageMs: z.number().finite(),
    primary: state, secondary: state,
    allowed: z.boolean().nullable(), limitReached: z.boolean().nullable(),
  }).strip().nullable(),
  priorDurations: z.tuple([z.number().finite().nullable(), z.number().finite().nullable()]),
  evidencePreserved: z.boolean(),
}).strip();
export type CodexQuotaObservation = z.infer<typeof codexQuotaObservationSchema>;

/** Reads only ten named quota headers. Invalid text never leaves this boundary. */
export function observeCodexQuotaHeaders(headers: Headers, previous: AccountQuota, next: AccountQuota, now: number): CodexQuotaObservation | undefined {
  try {
    const read = (name: string, isBoolean = false) => {
      const raw = headers.get(name);
      if (raw === null) return 'missing' as const;
      if (!raw.trim()) return 'empty' as const;
      if (isBoolean) return /^(true|false)$/iu.test(raw) ? raw.toLowerCase() === 'true' : 'invalid' as const;
      const value = Number(raw);
      return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : 'invalid' as const;
    };
    const readSlot = (name: string) => {
      const prefix = `x-codex-${name}`;
      return [read(`${prefix}-used-percent`), read(`${prefix}-window-minutes`),
        read(`${prefix}-reset-at`), read(`${prefix}-reset-after-seconds`), read(`${prefix}-over-limit`, true)];
    };
    const prior = previous.codexUsageEvidence;
    return codexQuotaObservationSchema.parse({
      primary: readSlot('primary'), secondary: readSlot('secondary'),
      priorUsage: prior ? { observedAt: prior.observedAt, ageMs: now - prior.observedAt,
        primary: prior.primary, secondary: prior.secondary, allowed: prior.allowed, limitReached: prior.limitReached } : null,
      priorDurations: ['primary', 'secondary'].map(name => previous.limitWindows.find(w => w.slot === name)?.windowMinutes ?? null),
      evidencePreserved: prior !== undefined && next.codexUsageEvidence === prior,
    });
  } catch { return undefined; } // Diagnostics must never affect forwarding.
}
