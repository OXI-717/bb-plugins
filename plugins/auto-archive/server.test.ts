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
  });
  expect(set).not.toHaveBeenCalled();
  expect(archive).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
