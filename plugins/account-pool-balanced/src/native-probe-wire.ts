import {z} from 'zod';
const id=z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const nativeProbeInputSchema=z.object({accountId:id,executorId:id,hostId:id,projectId:id,model:z.string().regex(/^[A-Za-z0-9_.:/-]{1,160}$/).optional()}).strict();
export const nativeProbeResultSchema=z.object({
 accountId:id,executorId:id,hostId:id,projectId:id,model:z.string().optional(),
 status:z.enum(['not-started','runtime-unavailable','catalog-received','model-responded','verification-required','model-unavailable','provider-error','stop-unconfirmed']),
 verified:z.boolean(),observedAt:z.number(),catalog:z.array(z.string().max(160)).max(128).default([]),
}).strict().refine(v=>v.verified===(v.status==='model-responded')&&(!v.verified||(v.model!==undefined&&v.catalog.includes(v.model))));
export const nativeProbeLaunchSchema=nativeProbeInputSchema.extend({protocol:z.literal(1),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),reservationId:z.string().uuid(),deadline:z.number()}).strict();
export type NativeProbeInput=z.infer<typeof nativeProbeInputSchema>;
export type NativeProbeResult=z.infer<typeof nativeProbeResultSchema>;
export type NativeProbeLaunch=z.infer<typeof nativeProbeLaunchSchema>;
