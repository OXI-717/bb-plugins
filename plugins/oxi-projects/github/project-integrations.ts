import { z } from "zod";
// Provider-neutral configuration. References identify saved credentials; never embed secrets.
const id = z.string().min(1).max(160);
const base = { id, label: z.string().min(1).max(120) };
export const integrationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...base,
      kind: z.literal("github"),
      accountRef: id,
      repositories: z.array(z.string().regex(/^[\w.-]+\/[\w.-]+$/)).max(50),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("jira"),
      accountRef: id,
      baseUrl: z
        .string()
        .url()
        .refine((v) => {
          const u = new URL(v);
          return (
            ["http:", "https:"].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash
          );
        }, "Нужен URL Jira без учётных данных"),
      projectKeys: z
        .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
        .min(1)
        .max(50),
      jql: z.string().max(4000).optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      kind: z.literal("tasknotes"),
      executable:z.string().startsWith("/").optional(),
      projectName:z.string().min(1).optional(),
      hostId: id,
      vaultPath: z.string().min(1).max(2000),
      folders: z.array(z.string().max(1000)).max(50),
      tags: z.array(z.string().max(120)).max(50),
    })
    .strict(),
]);
// A thread may be linked to several entities across providers. No numeric-only issue ID.
export const workReferenceSchema = z
  .object({
    projectId: id,
    integrationId: id,
    kind: z.enum(["epic", "issue", "pull-request", "note"]),
    externalId: z.string().min(1).max(2000),
  })
  .strict();
export type Integration = z.infer<typeof integrationSchema>;
