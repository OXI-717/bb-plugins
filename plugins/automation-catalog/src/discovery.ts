import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, extname } from "node:path";
import { z } from "zod";
import type { createCatalog } from "./catalog";

type Catalog = ReturnType<typeof createCatalog>;
type Command = (...args: string[]) => Promise<unknown>;
const threadId = /^thr_[A-Za-z0-9_-]+$/;
const limit = 65536;
export const definitionSchema = z.object({
  prompt: z.string().max(limit).nullable(),
  targetThreadId: z.string().nullable(),
  targetTitle: z.string().nullable(),
  targetHost: z.string().nullable(),
  kind: z.enum(["agent", "relay", "script"]),
  note: z.string(), nativeUrl: z.string(),
});
type Definition = z.infer<typeof definitionSchema>;
export const discoverySchema = z.object({
  matches: z.array(z.object({ key: z.string(), excerpt: z.string() })),
  unavailable: z.number(), checkedAt: z.number(),
});

// Recognize literal relay commands only. Never evaluate shell syntax or guess
// dynamically computed targets, paths, command substitutions or conditionals.
export function parseRelay(script: string): { target: string; file?: string; message?: string } | null {
  const commands = script.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#") && !/^export PATH=[^;]+$/.test(s));
  if (commands.length !== 1) return null;
  const line = commands[0];
  const tokens: string[] = [];
  const token = /\s*(?:'([^']*)'|"([^"$`\\]*)"|([^\s'"$`;|&<>\\()]+))/gy;
  let pos = 0;
  while (pos < line.length) {
    token.lastIndex = pos;
    const m = token.exec(line);
    if (!m) return null;
    tokens.push(m[1] ?? m[2] ?? m[3]); pos = token.lastIndex;
  }
  if (tokens[0] === "exec") tokens.shift();
  if (!/^(?:.*\/)?bb$/.test(tokens[0] ?? "") || tokens[1] !== "thread" || tokens[2] !== "tell" || !threadId.test(tokens[3] ?? "")) return null;
  if (tokens.length !== 6) return null;
  return tokens[4] === "--message-file" ? { target: tokens[3], file: tokens[5] }
    : tokens[4] === "--message" ? { target: tokens[3], message: tokens[5] } : null;
}

export async function readPromptFile(file: string, directory: string): Promise<string> {
  if (!isAbsolute(directory) || ![".md", ".txt"].includes(extname(file).toLowerCase())) throw new Error("unsupported prompt file");
  const root = await realpath(directory);
  const path = await realpath(resolve(root, file));
  if (![".md", ".txt"].includes(extname(path).toLowerCase())) throw new Error("unsupported resolved prompt file");
  const within = relative(root, path);
  if (!within || within === ".." || within.startsWith("../") || isAbsolute(within)) throw new Error("outside working directory");
  const handle = await open(path, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("unsupported prompt size");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("prompt too large");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

const automationSchema = z.object({
  id: z.string(), projectId: z.string(),
  execution: z.object({ mode: z.string(), prompt: z.string().optional(), script: z.string().optional(),
    targetThreadId: z.string().nullish(), resolvedWorkingDirectory: z.string().optional() }),
});
export async function readDefinition(catalog: Catalog, command: Command, key: string, targetMetadata = true): Promise<Definition> {
  const { task, source } = catalog.detail({ key, limit: 1 });
  if (!source.managedHere || task.scheduler !== "bb" || !task.projectId || task.missing) throw new Error("Задание можно прочитать только у действующей записи подключённого BB.");
  const value = automationSchema.parse(await command("automation", "show", task.id, "--project", task.projectId));
  if (value.id !== task.id || value.projectId !== task.projectId) throw new Error("Настройка не соответствует автоматизации.");
  const e = value.execution;
  let prompt: string | null = e.mode === "agent" ? e.prompt?.slice(0, limit) ?? null : null;
  let target = e.targetThreadId && threadId.test(e.targetThreadId) ? e.targetThreadId : null;
  let kind: Definition["kind"] = e.mode === "agent" ? "agent" : "script";
  let note = e.mode === "agent" ? "Задание прочитано из настройки BB." : "Произвольный скрипт: текст задания и тред автоматически не определены. Откройте настройку в BB.";
  if (e.mode === "script") {
    const relay = parseRelay(e.script ?? "");
    if (relay) {
      kind = "relay"; target = relay.target;
      prompt = relay.message?.slice(0, limit) ?? null;
      note = "Расписание запускает скрипт, который отправляет задание в существующий тред. Успех отправки не означает завершение работы агента.";
      if (relay.file) {
        try { prompt = await readPromptFile(relay.file, e.resolvedWorkingDirectory ?? ""); }
        catch { note += " Файл задания недоступен для чтения: поддерживаются файлы .md/.txt внутри рабочей папки скрипта, до 64 КБ."; }
      }
    }
  }
  let targetTitle: string | null = null, targetHost: string | null = null;
  if (target && targetMetadata) {
    try {
      const info = z.object({ thread: z.object({ title: z.string().nullish() }), environment: z.object({ hostId: z.string() }).nullish() }).parse(await command("thread", "show", target));
      targetTitle = info.thread.title ?? null;
      if (info.environment?.hostId) {
        const hosts = z.array(z.object({ id: z.string(), name: z.string() })).parse(await command("host", "list", "--all"));
        targetHost = hosts.find(h => h.id === info.environment?.hostId)?.name ?? null;
      }
    } catch { note += " Целевой тред или его хост сейчас недоступен."; }
  }
  return { prompt, targetThreadId: target, targetTitle, targetHost, kind, note,
    nativeUrl: `/plugins/automations/automations/${encodeURIComponent(task.projectId)}/${encodeURIComponent(task.id)}` };
}

function normalize(value: string) { return value.toLocaleLowerCase().replace(/\s+/g, " ").trim(); }
export function definitionMatch(definition: Definition, query: string): string | null {
  const q = normalize(query);
  const pastedThread = q.match(/(?:^|[/@\s:])(thr_[a-z0-9_-]+)(?=$|[/?#\s])/i)?.[1];
  if (definition.targetThreadId && (normalize(definition.targetThreadId) === q || normalize(definition.targetThreadId) === pastedThread)) return "Совпадение по целевому треду";
  const text = normalize(definition.prompt ?? "");
  const at = text.indexOf(q);
  if (q && at >= 0) return `Задание: …${(definition.prompt ?? "").replace(/\s+/g, " ").slice(Math.max(0, at - 40), at + q.length + 120).slice(0, 300)}…`;
  return null;
}

export function createDiscovery(catalog: Catalog, command: Command) {
  type Cache = { until: number; entries: { key: string; definition: Definition }[]; unavailable: number; checkedAt: number };
  let cached: Cache | null = null;
  let loading: Promise<Cache> | null = null;
  let generation = 0;
  async function load() {
    if (cached && cached.until > Date.now()) return cached;
    if (loading) return loading;
    const startedGeneration = generation;
    const pending = (async () => {
      const data = catalog.list();
      const tasks = data.tasks.filter(t => !t.missing && t.scheduler === "bb" && data.sources.some(s => s.id === t.sourceId && s.managedHere));
      const entries: Cache["entries"] = [];
      let cursor = 0, unavailable = 0;
      await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
        while (cursor < tasks.length) {
          const task = tasks[cursor++];
          try {
            const definition = await readDefinition(catalog, command, task.key, false);
            entries.push({ key: task.key, definition });
            if (!definition.prompt) unavailable++;
          } catch { unavailable++; }
        }
      }));
      return { entries, unavailable, checkedAt: Date.now(), until: Date.now() + 30000 };
    })();
    loading = pending;
    try {
      const result = await pending;
      if (generation === startedGeneration) cached = result;
      return result;
    } finally { if (loading === pending) loading = null; }
  }
  return {
    async search(query: string) {
      const data = await load();
      const matches = data.entries.flatMap(e => { const excerpt = definitionMatch(e.definition, query); return excerpt ? [{ key: e.key, excerpt }] : []; });
      return { matches, unavailable: data.unavailable, checkedAt: data.checkedAt };
    },
    clear() { generation++; cached = null; loading = null; },
  };
}
