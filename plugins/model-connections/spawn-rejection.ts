import { z } from "zod";
const preCreationCodes = new Set([
  "invalid_request",
  "validation_error",
  "project_not_found",
  "environment_not_found",
  "section_not_found",
  "provider_not_found",
  "model_not_found",
  "attachment_not_found",
  "invalid_attachment_reference",
]);
const sdkError = z.object({
  name: z.literal("BbHttpError"),
  status: z.number(),
  code: z.string(),
  body: z.object({ code: z.string() }),
});
export function knownSpawnRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const parsed = sdkError.safeParse(error);
  return (
    parsed.success &&
    [400, 404, 422].includes(parsed.data.status) &&
    preCreationCodes.has(parsed.data.code) &&
    parsed.data.body.code === parsed.data.code
  );
}
