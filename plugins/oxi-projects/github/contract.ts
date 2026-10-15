import { integrationSchema } from "./project-integrations";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { pullSchema, commentSchema } from "./upstream-schemas";
export const repoName = z.string().regex(/^[\w.-]+\/[\w.-]+$/);
export const login = z.string().regex(/^[\w-]+$/);
export const repository = z.object({ repo: repoName, account: login });
export const project = z
  .object({
    id: z.string().min(1).max(160),
    name: z.string().min(1).max(120),
    bbProjectId: z.string().nullable().default(null),
    autopilotProject: z.string().nullable().default(null),
    repositories: z.array(repository).max(50).default([]),
    integrations: z.array(integrationSchema).max(50).optional(),
  })
  .refine(
    (p) =>
      new Set(p.integrations?.map((i) => i.id) ?? []).size ===
        (p.integrations?.length ?? 0) &&
      new Set(p.repositories.map((r) => r.repo.toLowerCase())).size ===
        p.repositories.length,
    "Репозитории проекта не должны повторяться",
  );
export type Project = z.infer<typeof project>;
export const item = z.object({
  repo: repoName,
  account: login,
  number: z.number().int().positive(),
  kind: z.enum(["issue", "pr"]),
  title: z.string(),
  state: z.string(),
  author: z.string(),
  labels: z.array(z.string()),
  assignees: z.array(z.string()),
  updatedAt: z.string(),
  url: z.string(),
  body: z.string().default(""),
});
export const issueDetail = item
  .omit({ account: true, kind: true })
  .extend({ body: z.string(), comments: z.array(commentSchema) });
export const detail = z.union([pullSchema, issueDetail]);
export const scope = z.object({
  projectId: z.string(),
  repos: z.array(repoName).max(50).default([]),
  account: login.nullable().default(null),
  kind: z.enum(["issue", "pr"]),
  state: z.enum(["open", "closed", "all"]).default("open"),
});
export const contract = defineRpcContract({
  catalog: {
    input: z.null(),
    output: z.object({
      projects: z.array(project),
      accounts: z.array(login),
      accountError: z.string().nullable(),
    }),
  },
  saveProject: { input: project, output: project },
  list: {
    input: scope,
    output: z.object({
      items: z.array(item),
      errors: z.array(
        z.object({ repo: repoName, account: login, message: z.string() }),
      ),
      limited: z.array(repoName),
      at: z.string(),
    }),
  },
  read: {
    input: z.object({
      projectId: z.string(),
      repo: repoName,
      kind: z.enum(["issue", "pr"]),
      number: z.number().int().positive(),
    }),
    output: detail,
  },
});
