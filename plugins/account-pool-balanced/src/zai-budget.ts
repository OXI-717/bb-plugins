import { z } from 'zod';
import { zaiUsageEvidenceSchema, type AccountQuota, type ZaiUsageEvidence } from './contracts.js';

export const ZAI_BUDGET_MAX_AGE_MS = 300_000;
// Match the existing collector's numeric/string input contract without clamping,
// boolean coercion, empty strings or duration/reset-order inference.
const decimal = z.union([z.number().finite(), z.string().regex(/^\d+(?:\.\d+)?$/u).transform(Number)]).pipe(z.number().finite());
const row = z.object({type:z.string(), unit:z.number().int(), percentage:decimal,
  nextResetTime:decimal.pipe(z.number().int().min(1_000_000_000_000).max(Number.MAX_SAFE_INTEGER))}).passthrough();
const payloadSchema = z.object({code:z.literal(200).optional(),success:z.literal(true).optional(),
  data:z.object({limits:z.array(z.unknown())}).passthrough()}).passthrough();

/** Only a successful existing provider payload can create strict numeric proof. */
export function zaiEvidenceFromUsages(payload: unknown, now: number): ZaiUsageEvidence | undefined {
  const parsed=payloadSchema.safeParse(payload);
  if(!parsed.success)return undefined;
  const windows=parsed.data.data.limits.filter((value):value is Record<string,unknown> =>
    value !== null && typeof value === 'object' && 'type' in value && value.type === 'TOKENS_LIMIT');
  if(windows.length!==2)return undefined;
  const read=(unit:number) => {
    const candidates=windows.filter(value=>value.unit===unit);
    if(candidates.length!==1)return null;
    const result=row.safeParse(candidates[0]);
    if(!result.success || result.data.percentage<0 || result.data.percentage>100 || result.data.nextResetTime<=now)return null;
    return {usedPercent:result.data.percentage,resetAt:result.data.nextResetTime};
  };
  const fiveHour=read(3),weekly=read(6);
  if(!fiveHour||!weekly)return undefined;
  const evidence=zaiUsageEvidenceSchema.safeParse({source:'usage',observedAt:now,fiveHour,weekly});
  return evidence.success?evidence.data:undefined;
}

/** Cached numeric attestation only; this does not choose an account or relax floors. */
export function zaiBudgetQuota(quota:AccountQuota,now:number){
  const parsed=zaiUsageEvidenceSchema.safeParse(quota.zaiUsageEvidence);
  const proof=parsed.success?parsed.data:undefined;
  const valid=proof!==undefined && proof.observedAt<=now && now-proof.observedAt<=ZAI_BUDGET_MAX_AGE_MS &&
    proof.fiveHour.resetAt>now && proof.weekly.resetAt>now && quota.error===null;
  const window=(kind:'fiveHour'|'weekly')=> valid ? {state:'present' as const,
    remainingPercent:100-proof[kind].usedPercent,resetAt:proof[kind].resetAt,observedAt:proof.observedAt,source:'usage' as const} :
    {state:'unknown' as const,remainingPercent:null,resetAt:null,observedAt:null,source:null};
  return {budgetReady:valid,usage:proof?{source:'usage' as const,observedAt:proof.observedAt,complete:true}:null,
    windows:{fiveHour:window('fiveHour'),weekly:window('weekly')}};
}
