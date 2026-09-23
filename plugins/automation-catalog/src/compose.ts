import { z } from "zod";
import type { NewThreadRequest } from "@get-bb/plugin-sdk/app";
// Validate the transport envelope here. The host SDK validates provider input,
// workspace selection and prompt attachments using its authoritative schemas.
export const composeRequestSchema = z
  .object({
    projectId: z.string().min(1).max(300),
    providerId: z.string().min(1).max(300),
    model: z.string().min(1).max(300),
    reasoningLevel: z.enum([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
      "ultracode",
    ]),
    permissionMode: z.enum(["accept-edits", "auto", "full"]),
    serviceTier: z.enum(["default", "fast"]).optional(),
    executionInputSources: z.record(z.string(), z.json()),
    environment: z.record(z.string(), z.json()),
    input: z.array(z.record(z.string(), z.json())).min(1).max(100),
    sendAt: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) => JSON.stringify(value).length <= 1_000_000,
    "Request too large",
  );
export function hostRequest(
  input: z.infer<typeof composeRequestSchema>,
): NewThreadRequest {
  return input as unknown as NewThreadRequest;
}
