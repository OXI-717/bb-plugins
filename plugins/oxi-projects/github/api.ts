import { execFile } from "node:child_process";
import { z } from "zod";
import { login, item, scope, type Project } from "./contract";
import { readApi } from "./upstream-read";
import { resolveGhPath, invalidateGhPath } from "../sources/github";
import {cliFailureKind,GithubCliError,isRetryableGithubRead} from './cli-failure';
import {setTimeout as delay} from 'node:timers/promises';
type RunnerOptions={retryRead?:boolean};
export type Runner = (
  args: string[],
  env: NodeJS.ProcessEnv,
  timeout?: number,
  options?: RunnerOptions,
) => Promise<string>;
const repositoryItemSchema = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])),
  assignees: z.array(z.object({ login: z.string() })),
  updated_at: z.string(),
  html_url: z.string(),
  body: z.string().nullable().default(null),
  pull_request: z.unknown().optional(),
});
export function parseRepositoryItems(raw: string, kind: "issue" | "pr") {
  const pages = z.array(z.array(repositoryItemSchema)).parse(JSON.parse(raw));
  return pages.flat().filter((entry) =>
    kind === "pr" ? entry.pull_request !== undefined : entry.pull_request === undefined,
  );
}
/** A page can recover independently; an incomplete traversal is never returned. */
export async function readRepositoryPages(
 gh:(args:string[],timeout?:number,options?:RunnerOptions)=>Promise<string>,
 repo:string,state:'open'|'closed'|'all',kind:'issue'|'pr',deadline=Date.now()+120_000,
){
 const pages:Array<z.infer<typeof repositoryItemSchema>>=[];
 let bytes=0;
 for(let page=1;;page++){
  let raw='';
  for(let attempt=0;;attempt++){
   const remaining=deadline-Date.now();
   if(remaining<=0)throw new GithubCliError('timeout',null,'полная загрузка списка');
   try{
    raw=await gh(['api',`repos/${repo}/issues?state=${state}&per_page=100&page=${page}`],Math.min(20_000,remaining),{retryRead:false});
    break;
   }catch(error){
    if(attempt===0&&error instanceof GithubCliError&&['timeout','network'].includes(error.kind)&&deadline-Date.now()>500){
     await delay(250);continue;
    }
    if(error instanceof GithubCliError)throw new GithubCliError(error.kind,error,`страница ${page} списка задач`);
    throw error;
   }
  }
  bytes+=Buffer.byteLength(raw,'utf8');
  if(bytes>64*1024*1024)throw new GithubCliError('response_too_large',null,'список задач');
  const items=z.array(repositoryItemSchema).max(100).parse(JSON.parse(raw));
  pages.push(...items);
  if(items.length<100)return pages.filter(entry=>kind==='pr'?entry.pull_request!==undefined:entry.pull_request===undefined);
 }
}
export const makeRunner =
  (signal?: AbortSignal): Runner =>
  async (args, env, timeout = 30_000,options={}) => {
    const deadline=Date.now()+timeout;
    const stage=args[0]==='auth'?'получение авторизации':args[0]==='api'?'запрос API':'команда GitHub';
    for (let attempt = 0; attempt < 2; attempt++) {
      if(signal?.aborted)throw new GithubCliError('cancelled',null,stage);
      let binary: string;
      try {
        binary = await resolveGhPath();
      } catch {
        throw Error("GitHub CLI не найден на хосте BB. Установите gh или задайте абсолютный GH_PATH для процесса BB.");
      }
      const remaining=deadline-Date.now();
      if(remaining<=0)throw new GithubCliError('timeout',null,stage);
      let stderr='';
      try {
        return await new Promise<string>((resolve, reject) =>
          execFile(
            binary,
            args,
            { env, timeout:remaining, signal, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
            (error, out, err) => {
              stderr=err??'';
              error ? reject(error) : resolve(out);
            },
          ),
        );
      } catch (error) {
        // ENOENT means the process never started: safe even for mutation commands.
        // Homebrew upgrades can remove the cached versioned Cellar binary.
        if (attempt === 0 && (error as NodeJS.ErrnoException).code === "ENOENT") {
          invalidateGhPath(binary);
          continue;
        }
        const kind=cliFailureKind(error,stderr);
        if(attempt===0&&options.retryRead!==false&&kind==='network'&&isRetryableGithubRead(args)&&deadline-Date.now()>500&&!signal?.aborted){
          try{await delay(250,undefined,{signal});}catch{throw new GithubCliError('cancelled',null,stage);}
          continue;
        }
        throw new GithubCliError(kind,error,stage);
      }
    }
    throw Error("GitHub CLI недоступен после повторного поиска.");
  };
export const run = makeRunner();
export function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
  ])
    delete env[key];
  return { ...env, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" };
}
export async function accounts(runner = run) {
  const value = JSON.parse(
    await runner(
      ["auth", "status", "--hostname", "github.com", "--json", "hosts"],
      cleanEnv(),
    ),
  );
  return [
    ...new Set(
      z
        .array(z.object({ login }))
        .parse(value.hosts?.["github.com"] ?? [])
        .map((a) => a.login),
    ),
  ];
}
export async function accountClient(account: string, runner = run) {
  login.parse(account);
  const env = cleanEnv();
  const token = (
    await runner(
      ["auth", "token", "--hostname", "github.com", "--user", account],
      env,
    )
  ).trim();
  if (!token) throw Error(`Аккаунт ${account}: нет сохранённого токена`);
  // Tokens remain inside this request's subprocess environment; never persist or return them.
  return (args: string[], timeout?: number,options?:RunnerOptions) =>
    runner(args, { ...env, GH_TOKEN: token }, timeout,options);
}
export function selectedRepositories(
  project: Project,
  input: z.infer<typeof scope>,
) {
  if (
    input.repos.some(
      (repo) => !project.repositories.some((r) => r.repo === repo),
    )
  )
    throw Error("Репозиторий не относится к выбранному проекту");
  return project.repositories.filter(
    (r) =>
      (!input.repos.length || input.repos.includes(r.repo)) &&
      (!input.account || r.account === input.account),
  );
}
export async function listProject(
  project: Project,
  input: z.infer<typeof scope>,
  runner = run,
) {
  const selected = selectedRepositories(project, input);
  const results = [];
  // Bound GitHub concurrency and isolate account credentials per repository.
  for (let i = 0; i < selected.length; i += 3) {
    results.push(
      ...(await Promise.all(
        selected.slice(i, i + 3).map(async (r) => {
          try {
            const deadline=Date.now()+120_000;
            const gh = await accountClient(r.account, runner);
            const raw = await readRepositoryPages(gh,r.repo,input.state,input.kind,deadline);
            return {
              items: raw.map((v) =>
                item.parse({
                  ...r,
                  kind: input.kind,
                  number: v.number,
                  title: v.title,
                  state: v.state.toUpperCase(),
                  author: v.user?.login ?? "",
                  labels: v.labels.map((l) => typeof l === "string" ? l : l.name),
                  assignees: v.assignees.map((a) => a.login),
                  updatedAt: v.updated_at,
                  url: v.html_url,
                  body: v.body ?? "",
                }),
              ),
              limited: null,
              error: null,
            };
          } catch (error) {
            return {
              items: [],
              limited: null,
              error: {
                ...r,
                message:
                  error instanceof Error ? error.message : "Ошибка GitHub",
              },
            };
          }
        }),
      )),
    );
  }
  return {
    items: results
      .flatMap((r) => r.items)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    errors: results.flatMap((r) => (r.error ? [r.error] : [])),
    limited: results.flatMap((r) => (r.limited ? [r.limited] : [])),
    at: new Date().toISOString(),
  };
}
export async function readItem(
  project: Project,
  input: { repo: string; kind: "issue" | "pr"; number: number },
  runner = run,
) {
  const r = project.repositories.find((r) => r.repo === input.repo);
  if (!r) throw Error("Репозиторий не относится к выбранному проекту");
  const api = readApi(await accountClient(r.account, runner));
  return input.kind === "pr"
    ? (await api.getPull(input)).pull
    : (await api.getIssue(input)).issue;
}
