import { it, expect, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server.js";
it("starts observation-only and preserves install timestamp across reloads", async () => {
  let definitions: Record<string, { default: unknown }> = {};
  const data = new Map<string, unknown>([["permanent-migration-v1", true]]);
  const service = vi.fn();
  const register = vi.fn();
  const bb = {
    settings: {
      define: (defs: typeof definitions) => {
        definitions = defs;
        return {
          get: async () =>
            Object.fromEntries(
              Object.entries(defs).map(([k, v]) => [k, v.default]),
            ),
        };
      },
    },
    storage: {
      kv: {
        get: async (key: string) => data.get(key),
        set: async (key: string, value: unknown) => {
          data.set(key, value);
        },
      },
    },
    background: { service },
    cli: { register },
  } as unknown as BbPluginApi;
  await plugin(bb);
  expect(definitions.dryRun.default).toBe(true);
  expect(definitions.inactivityDays.default).toBe("14");
  expect(definitions.detachActiveDescendants.default).toBe(false);
  expect(definitions.keepThreadIds.default).toBe("[]");
  expect(definitions.unarchiveGraceMultiplier.default).toBe("2");
  expect(definitions.enableArchivedFileCleanup.default).toBe(false);
  expect(definitions.clearArchivedFilesAfterDays.default).toBe("14");
  expect(definitions.enableAutomatedExportDelete.default).toBe(false);
  expect(definitions.exportDeleteAfterDays.default).toBe("30");
  expect(definitions.exportDir.default).toBe("");
  expect(definitions.retentionMaxPerRun.default).toBe("50");
  const first = data.get("installed-at");
  await plugin(bb);
  expect(data.get("installed-at")).toBe(first);
  expect(service).toHaveBeenCalledWith(
    "sweeper",
    expect.objectContaining({ start: expect.any(Function) }),
  );
  expect(register).toHaveBeenCalled();
});

it("status returns fresh exclusion counts and preserves existing settings and install time", async () => {
  const saved = {
    inactivityDays: "14",
    keepThreadIds: '["thr_kept"]',
    detachActiveDescendants: false,
    dryRun: false,
  };
  const data = new Map<string, unknown>([["installed-at", 123], ["permanent-migration-v1", true]]);
  const set = vi.fn(async () => {});
  const archive = vi.fn();
  const update = vi.fn();
  const list = vi.fn(async () => [
    {
      id: "thr_upper",
      title: "DB",
      titleFallback: null,
      pinnedAt: null,
      archivedAt: null,
      deletedAt: null,
    },
    {
      id: "thr_kept",
      title: "📌 lowercase",
      pinnedAt: 1,
      archivedAt: null,
      deletedAt: null,
    },
  ]);
  const register = vi.fn();
  const bb = {
    settings: { define: () => ({ get: async () => saved }) },
    storage: { kv: { get: async (key: string) => data.get(key), set } },
    background: { service: vi.fn() },
    cli: { register },
    sdk: { threads: { list, archive, update, experimental_listPluginMetadata: async () => ({threads: []}) } },
  } as unknown as BbPluginApi;
  await plugin(bb);
  const command = register.mock.calls[0][0];
  const result = await command.run(["status"], {
    signal: new AbortController().signal,
  });
  const status = JSON.parse(result.stdout);
  expect(status.exclusions).toEqual({
    scanned: 2,
    reasons: { pinned: 1, pinPrefix: 1, permanent: 0, keepThreadIds: 1 },
    overlapping: true,
  });
  expect(status.config).toEqual({
    ...saved,
    inactivityDays: 14,
    keepThreadIds: ["thr_kept"],
    sinceInstallAt: 123,
    unarchiveGraceMultiplier: 2,
    enableArchivedFileCleanup: false,
    clearArchivedFilesAfterDays: 14,
    enableAutomatedExportDelete: false,
    exportDeleteAfterDays: 30,
    exportDir: "",
    automatedOriginPluginIds: [
      "workflows",
      "automations",
      "automation-catalog",
      "oxi-autopilot",
      "aim-growth",
    ],
    retentionMaxPerRun: 50,
  });
  expect(set).not.toHaveBeenCalled();
  expect(archive).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

it("records thread.unarchived events and exposes retention --dry-run CLI command", async () => {
  const data = new Map<string, unknown>([
    ["installed-at", 123],
    ["permanent-migration-v1", true],
  ]);
  const listeners = new Map<string, (payload: unknown) => Promise<void>>();
  const meta = new Map<string, Record<string, unknown>>();
  const register = vi.fn();
  const bb = {
    settings: {
      define: (defs: Record<string, { default: unknown }>) => ({
        get: async () =>
          Object.fromEntries(
            Object.entries(defs).map(([k, v]) => [k, v.default]),
          ),
      }),
    },
    storage: {
      kv: {
        get: async (key: string) => data.get(key),
        set: async (key: string, value: unknown) => {
          data.set(key, value);
        },
      },
    },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    events: {
      on: (name: string, fn: (payload: unknown) => Promise<void>) => {
        listeners.set(name, fn);
      },
    },
    background: { service: vi.fn() },
    cli: { register },
    sdk: {
      threads: {
        list: vi.fn(async () => []),
        getPluginMetadata: vi.fn(async ({ threadId }: { threadId: string }) => meta.get(threadId) ?? {}),
        updatePluginMetadata: vi.fn(
          async ({ threadId, set }: { threadId: string; set?: Record<string, unknown> }) => {
            meta.set(threadId, { ...(meta.get(threadId) ?? {}), ...set });
          },
        ),
        experimental_listPluginMetadata: vi.fn(async () => ({ threads: [] })),
      },
    },
  } as unknown as BbPluginApi;

  await plugin(bb);
  const onUnarchive = listeners.get("thread.unarchived");
  expect(onUnarchive).toBeDefined();
  await onUnarchive!({ thread: { id: "thr_returned" } });
  expect(meta.get("thr_returned")).toEqual(
    expect.objectContaining({ unarchiveCount: 1, lastUnarchivedAt: expect.any(Number) }),
  );

  const command = register.mock.calls[0][0];
  const res = await command.run(["retention", "--dry-run"], {
    signal: new AbortController().signal,
  });
  expect(res.exitCode).toBe(0);
  const parsed = JSON.parse(res.stdout);
  expect(parsed.dryRun).toBe(true);
  expect(parsed.fileCleanup.clearedCount).toBe(0);
  expect(parsed.exportDelete.deletedCount).toBe(0);
});
