import { it, expect, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
const makeThreadResponse = (row: {id: string; title?: string | null; titleFallback?: string | null; archivedAt?: number}) => ({titleFallback: null, archivedAt: null, deletedAt: null, ...row});
import {
  loadThreadProtectionMeta,
  migratePermanentThreads,
  permanentIds,
  recordThreadUnarchived,
} from "./permanent.js";

function host() {
  const rows = [
    makeThreadResponse({id: "thr_upper", title: "PERMANENT"}),
    makeThreadResponse({id: "thr_pin", title: "📌 regular"}),
    makeThreadResponse({id: "thr_kept", title: "regular"}),
    makeThreadResponse({id: "thr_normal", title: "normal"}),
    makeThreadResponse({id: "thr_fallback", title: null, titleFallback: "UPPER"}),
    makeThreadResponse({id: "thr_archived", title: "OLD", archivedAt: 1}),
  ];
  const values = new Map<string, Record<string, boolean | string>>();
  const write = vi.fn(async ({threadId, set}: {threadId: string; set?: Record<string, unknown>}) => {
    const value = {...values.get(threadId), ...set}; values.set(threadId, value as Record<string, boolean>); return value;
  });
  const storage = new Map<string, unknown>();
  const bb = {storage: {kv: {
    get: async (key: string) => storage.get(key) ?? null,
    set: async (key: string, value: unknown) => {storage.set(key, value);},
  }}, sdk: {threads: {
    list: async () => rows,
    getPluginMetadata: async ({threadId}: {threadId: string}) => values.get(threadId) ?? {},
    updatePluginMetadata: write,
    experimental_listPluginMetadata: async ({threadIds}: {threadIds: string[]}) => ({threads: threadIds.filter(id => values.has(id))
      .map(threadId => ({threadId, metadata: values.get(threadId)!}))}),
  }}} as unknown as BbPluginApi;
  const harness = {lifecycle: {dispose: async () => {}}};
  return {bb, harness, values, rows, write};
}
it("migrates legacy protection once, preserves metadata and explicit later opt-out", async () => {
  const h = host();
  h.values.set("thr_upper", {other: "preserved"});
  try {
    await migratePermanentThreads(h.bb, ["thr_kept"]);
    expect([...h.values.keys()].sort()).toEqual(["thr_kept", "thr_pin", "thr_upper"]);
    expect(h.values.get("thr_upper")).toEqual({other: "preserved", permanent: true});
    h.values.set("thr_upper", {permanent: false});
    h.rows.push(makeThreadResponse({id: "thr_later", title: "NEW"}));
    await migratePermanentThreads(h.bb, ["thr_kept"]);
    expect(h.write).toHaveBeenCalledTimes(3);
    expect(h.values.has("thr_later")).toBe(false);
    expect(await permanentIds(h.bb, h.rows.map(t => t.id as string))).toEqual(new Set(["thr_pin", "thr_kept"]));
  } finally { await h.harness.lifecycle.dispose(); }
});
it("partial migration is retryable and must complete before archive can start", async () => {
  const h = host();
  h.write.mockImplementationOnce(h.write.getMockImplementation()!).mockRejectedValueOnce(new Error("write unavailable"));
  try {
    await expect(migratePermanentThreads(h.bb, ["thr_kept"])).rejects.toThrow("write unavailable");
    expect(await h.bb.storage.kv.get("permanent-migration-v1")).toBeNull();
    await migratePermanentThreads(h.bb, ["thr_kept"]);
    expect(h.values.get("thr_kept")?.permanent).toBe(true);
  } finally { await h.harness.lifecycle.dispose(); }
});
it("invalid permanent metadata fails closed", async () => {
  const h = host(); h.values.set("thr_upper", {permanent: "true"});
  try { await expect(permanentIds(h.bb, ["thr_upper"])).rejects.toThrow("Invalid permanent"); }
  finally { await h.harness.lifecycle.dispose(); }
});
it("records thread unarchive count without clobbering permanent metadata", async () => {
  const h = host();
  h.values.set("thr_normal", { permanent: false });
  const first = await recordThreadUnarchived(h.bb, "thr_normal", 10_000);
  expect(first).toEqual({ unarchiveCount: 1, lastUnarchivedAt: 10_000 });
  const second = await recordThreadUnarchived(h.bb, "thr_normal", 20_000);
  expect(second).toEqual({ unarchiveCount: 2, lastUnarchivedAt: 20_000 });
  expect(h.values.get("thr_normal")).toEqual({
    permanent: false,
    unarchiveCount: 2,
    lastUnarchivedAt: 20_000,
  });
  const loaded = await loadThreadProtectionMeta(h.bb, ["thr_normal"]);
  expect(loaded.get("thr_normal")).toEqual({
    permanent: false,
    unarchiveCount: 2,
    lastUnarchivedAt: 20_000,
  });
});
