import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { linkSchema } from "./dispatch";
import { detailSchema } from "./work";
import { collectionSchema, snapshotSchema, sourceSchema } from "./model";
export const modelPlanSchema = z.object({
  engines: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).max(20),
  fix_engines: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).max(20),
  allow_premium_auto: z.boolean(),
  dev: z.record(z.string(), z.object({model:z.string().min(1).max(120),effort:z.string().min(1).max(20)}).strict()),
  review: z.record(z.string(), z.object({model:z.string().min(1).max(120),effort:z.string().min(1).max(20)}).strict()),
}).strict();
export const hostContract = defineRpcContract({
  collect: { input: sourceSchema, output: collectionSchema },
  saveModelPlan: {
    input: z.object({source:sourceSchema,project:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),plan:modelPlanSchema,fleetRevision:z.string().regex(/^[0-9a-f]{40}$/).optional()}).strict(),
    output: z.object({changed:z.boolean()}),
  },
  project: {
    input: z.object({
      source: sourceSchema,
      project: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/),
    }),
    output: detailSchema,
  },
});
export const rpcContract = defineRpcContract({
  saveModelPlan: {
    input: z.object({sourceId:z.string(),project:z.string(),plan:modelPlanSchema,fleetRevision:z.string().regex(/^[0-9a-f]{40}$/).optional()}).strict(),
    output: z.object({changed:z.boolean()}),
  },
  dispatchInfo: {
    input: z.null(),
    output: z.object({
      ready: z.boolean(),
      projectId: z.string().nullable(),
      model: z.string().nullable(),
      error: z.string().nullable(),
    }),
  },
  dispatch: {
    input: z
      .object({
        sourceId: z.string(),
        project: z.string(),
        problem: z.string().min(1).max(2000),
        templateThreadId:z.string().optional(),
      })
      .strict(),
    output: linkSchema,
  },
  links: {
    input: z.object({ sourceId: z.string(), project: z.string() }),
    output: z.array(linkSchema),
  },
  project: {
    input: z.object({
      sourceId: z.string(),
      project: z.string(),
      refresh: z.boolean().optional(),
    }),
    output: z.object({
      data: detailSchema.nullable(),
      error: z.string().nullable(),
      loading: z.boolean(),
    }),
  },
  status: {
    input: z.null(),
    output: z.object({
      snapshots: z.array(snapshotSchema),
      refreshing: z.boolean(),
      configurationError: z.string().nullable(),
      now: z.string(),
      projectObservations: z.array(
        z.object({
          sourceId: z.string(),
          project: z.string(),
          at: z.string(),
          rows: z.array(z.string()),
          datedRows: z.array(z.object({at:z.string(),row:z.string()})).optional(),
        }),
      ),
    }),
  },
  refresh: { input: z.null(), output: z.object({ accepted: z.boolean() }) },
});
