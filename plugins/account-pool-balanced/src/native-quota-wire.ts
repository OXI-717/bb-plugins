import {z} from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const nativeQuotaTargetSchema = z.object({hostId:id, executorId:id, accountId:id}).strict();
export const nativeQuotaRowSchema = z.object({
  group: z.string().min(1).max(256).regex(/^[^\u0000-\u001f\u007f]+$/u),
  window: z.enum(['fiveHour','weekly']),
  remainingPercent: z.number().min(0).max(100),
  resetAt: z.number().int().positive().max(8_640_000_000_000_000),
}).strict();
export const nativeQuotaViewSchema = z.object({
  observedAt: z.number().int().positive(),
  rows: z.array(nativeQuotaRowSchema).min(1).max(128),
}).strict();
export const nativeQuotaReportSchema = nativeQuotaTargetSchema.extend(nativeQuotaViewSchema.shape).extend({
  schema: z.literal('oxi/native-account-quota/1'),
}).strict().refine(report => report.rows.every(row => row.resetAt > report.observedAt)
  && new Set(report.rows.map(row => JSON.stringify([row.group,row.window]))).size === report.rows.length
  && new Set(report.rows.map(row => row.window)).size === 2);

export type NativeQuotaTarget = z.infer<typeof nativeQuotaTargetSchema>;
export type NativeQuotaView = z.infer<typeof nativeQuotaViewSchema>;
