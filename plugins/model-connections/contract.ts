import { defineRpcContract } from "@get-bb/plugin-sdk";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
export const id = z.string().min(1).max(160);
export const reasoning = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "ultracode",
]);
export const selection = z
  .object({
    providerId: id,
    model: z.string().min(1).max(200),
    reasoningLevel: reasoning,
  })
  .strict();
export const rowSchema = z.object({
  id,
  name: z.string(),
  available: z.boolean(),
  logoUrl: z.string().nullable(),
  icon: z.string(),
  group: z.enum(["local", "pool"]),
  selectable: z.boolean(),
  hidden: z.boolean(),
  detail: z.string(),
  mark: z.string().nullable(),
});
export const catalogInput = z
  .object({ threadId: id.optional(), hostId: id.optional() })
  .strict();
export const catalogOutput = z.object({
  hostId: id,
  hosts: z.array(z.object({ id, name: z.string() })),
  environmentId: id.nullable(),
  projectId: id.nullable(),
  currentProviderId: id.nullable(),
  poolAvailable: z.boolean(),
  connections: z.array(rowSchema),
});
const composerEnvelope = z
  .object({
    projectId: id,
    providerId: id,
    model: z.string().min(1),
    reasoningLevel: reasoning,
    permissionMode: z.enum(["auto", "full", "accept-edits"]),
    serviceTier: z.string().optional(),
    executionInputSources: z.record(
      z.string(),
      z.enum(["explicit", "client-preference"]),
    ),
    environment: z
      .object({
        type: z.enum(["reuse", "host", "provider", "project-default"]),
      })
      .passthrough(),
    input: z.array(z.json()).min(1),
    sendAt: z.number().int().positive().optional(),
  })
  .strict();
const composerRequest = z.custom<NewThreadRequest>(
  (value) => composerEnvelope.safeParse(value).success,
  "Invalid host composer request",
);
export const contract = defineRpcContract({
  catalog: { input: catalogInput, output: catalogOutput },
  visibility: {
    input: z
      .object({ hostId: id, providerId: id, hidden: z.boolean() })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  apply: {
    input: selection
      .extend({ threadId: id, expectedGroup: z.enum(["local", "pool"]) })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  create: {
    input: z
      .object({
        request: composerRequest,
        requestId: z.string().uuid(),
        expectedProviderId: id,
        expectedGroup: z.enum(["local", "pool"]),
        sourceThreadId: id.optional(),
      })
      .strict(),
    output: z.object({ threadId: id }),
  },
});
