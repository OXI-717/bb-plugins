import {z} from 'zod';
import {machineMarksConfigSchema} from './machine-marks';
export const machineHostSchema=z.object({id:z.string().max(100),name:z.string().max(500)}).strict();
export const machineMarksViewSchema=z.object({config:machineMarksConfigSchema.nullable(),revision:z.string().regex(/^[a-f0-9]{64}$/),hosts:z.array(machineHostSchema).max(200),error:z.string().nullable()}).strict();
export const machineMarksContract={
 machineMarksRead:{input:z.object({}).strict(),output:machineMarksViewSchema},
 machineMarksSave:{input:z.object({config:machineMarksConfigSchema,revision:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),output:z.object({saved:z.literal(true)}).strict()},
 machineMarkThread:{input:z.object({threadId:z.string().regex(/^thr_[A-Za-z0-9_-]+$/).max(100)}).strict(),output:z.object({host:machineHostSchema.nullable()}).strict()}
};
export type MachineMarksView=z.infer<typeof machineMarksViewSchema>;
