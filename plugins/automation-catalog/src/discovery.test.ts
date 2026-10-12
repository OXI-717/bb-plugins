import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRelay, readPromptFile, readDefinition, definitionMatch, createDiscovery } from "./discovery";
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
const task = { key: "ext_sample", id: "auto_sample", projectId: "project_sample", scheduler: "bb", missing: false, sourceId: "local" };
const source = { id: "local", managedHere: true };
const catalog = { detail: () => ({ task, source }), list: () => ({ tasks: [task], sources: [source] }) } as unknown as Parameters<typeof readDefinition>[0];
const automation = { id: task.id, projectId: task.projectId, execution: { mode: "agent", prompt: "Daily check of team chats", targetThreadId: "thr_sample" } };
describe("automation discovery", () => {
  it("recognizes literal relays without evaluating shell syntax", () => {
    expect(parseRelay('#!/bin/bash\nexport PATH=/usr/bin:/bin\nexec /opt/bb thread tell thr_sample --message-file "/work/project/daily prompt.md"')).toEqual({ target: "thr_sample", file: "/work/project/daily prompt.md" });
    expect(parseRelay("bb thread tell thr_sample --message 'Check team chats'" )).toEqual({ target: "thr_sample", message: "Check team chats" });
    for (const script of ['bb thread tell thr_sample --message-file "$PATH"', 'bb thread tell thr_sample --message-file $(whoami)', 'false && bb thread tell thr_sample --message hi', 'bb thread tell thr_sample --message hi\nbb thread tell thr_other --message hi']) expect(parseRelay(script)).toBeNull();
  });
  it("reads only bounded text files inside the resolved working directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "catalog-discovery-")); directories.push(root);
    const workspace = join(root, "workspace"); await mkdir(workspace);
    await writeFile(join(workspace, "prompt.md"), "Check messages");
    expect(await readPromptFile("prompt.md", workspace)).toBe("Check messages");
    await writeFile(join(root, "outside.md"), "Private outside file");
    await symlink(join(root, "outside.md"), join(workspace, "link.md"));
    await expect(readPromptFile("link.md", workspace)).rejects.toThrow("outside");
    await expect(readPromptFile("../outside.md", workspace)).rejects.toThrow("outside");
    await writeFile(join(workspace, ".env"), "SYNTHETIC_PRIVATE_VALUE");
    await symlink(join(workspace, ".env"), join(workspace, "disguised.md"));
    await expect(readPromptFile("disguised.md", workspace)).rejects.toThrow("resolved");
    await expect(readPromptFile(".env", workspace)).rejects.toThrow();
    await writeFile(join(workspace, "large.md"), "x".repeat(65537));
    await expect(readPromptFile("large.md", workspace)).rejects.toThrow();
  });
  it("finds a prompt phrase and pasted thread URL and resolves the target host", async () => {
    const command = vi.fn(async (...args: string[]) => args[0] === "automation" ? automation : args[0] === "thread" ? { thread: { title: "Team chat monitor" }, environment: { hostId: "host_worker" } } : [{ id: "host_worker", name: "Worker" }]);
    const definition = await readDefinition(catalog, command, task.key);
    expect(definition).toMatchObject({ targetThreadId: "thr_sample", targetTitle: "Team chat monitor", targetHost: "Worker" });
    expect(definitionMatch(definition, "CHECK  OF\nTEAM")).toContain("Задание");
    expect(definitionMatch(definition, "https://example.test/projects/project_sample/threads/thr_sample?tab=chat")).toContain("треду");
    expect(definitionMatch(definition, "thr_other")).toBeNull();
  });
  it("keeps target discoverable when a relay file cannot be read", async () => {
    const command = vi.fn(async () => ({ ...automation, execution: { mode: "script", script: 'exec bb thread tell thr_sample --message-file /missing/prompt.md', resolvedWorkingDirectory: "/missing" } }));
    const value = await readDefinition(catalog, command, task.key, false);
    expect(value).toMatchObject({ kind: "relay", prompt: null, targetThreadId: "thr_sample" });
    expect(value.note).toContain("недоступен");
  });
  it("rejects mismatched identities and external sources", async () => {
    await expect(readDefinition(catalog, async () => ({ ...automation, id: "other" }), task.key)).rejects.toThrow("не соответствует");
    const external = { ...catalog, detail: () => ({ task, source: { managedHere: false } }) } as unknown as typeof catalog;
    const command = vi.fn(); await expect(readDefinition(external, command, task.key)).rejects.toThrow(); expect(command).not.toHaveBeenCalled();
  });
  it("coalesces searches, exposes incomplete coverage and invalidates cached definitions", async () => {
    const command = vi.fn(async () => automation);
    const discovery = createDiscovery(catalog, command);
    const [a, b] = await Promise.all([discovery.search("team chats"), discovery.search("thr_sample")]);
    expect(a.matches).toHaveLength(1); expect(b.matches).toHaveLength(1); expect(command).toHaveBeenCalledTimes(1);
    discovery.clear(); await discovery.search("team chats"); expect(command).toHaveBeenCalledTimes(2);
    const unavailable = createDiscovery(catalog, async () => { throw Error("offline"); });
    expect(await unavailable.search("anything")).toMatchObject({ matches: [], unavailable: 1 });
  });
  it("does not restore an in-flight cache after explicit refresh", async () => {
    let resolveOld!: (value: unknown) => void;
    const old = new Promise<unknown>(resolve => { resolveOld = resolve; });
    const current = { ...automation, execution: { ...automation.execution, prompt: "New definition" } };
    const command = vi.fn().mockImplementationOnce(() => old).mockResolvedValue(current);
    const discovery = createDiscovery(catalog, command);
    const first = discovery.search("team chats");
    discovery.clear();
    expect((await discovery.search("New definition")).matches).toHaveLength(1);
    resolveOld(automation); await first;
    expect((await discovery.search("New definition")).matches).toHaveLength(1);
    expect((await discovery.search("team chats")).matches).toHaveLength(0);
    expect(command).toHaveBeenCalledTimes(2);
  });
});
