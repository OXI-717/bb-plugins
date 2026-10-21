import { it, expect, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { runOperation, collect, parseKeep, parseDays } from "./runtime.js";
import { DAY } from "./policy.js";
const config = {
  inactivityDays: 14,
  sinceInstallAt: DAY,
  keepThreadIds: [],
  detachActiveDescendants: false,
  dryRun: false,
};
const now = 100 * DAY;
function host(
  extra: Record<string, unknown> = {},
  children: Record<string, unknown>[] = [],
) {
  const row = (id: string, fields: Record<string, unknown> = {}) => ({
    id,
    title: id,
    titleFallback: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    visibility: "visible",
    latestAttentionAt: 70 * DAY,
    status: "idle",
    pinnedAt: null,
    archivedAt: null,
    environmentId: "env_example",
    environmentIsWorktree: true,
    queuedWork: "none",
    hasPendingInteraction: false,
    activity: {},
    ...fields,
  });
  const rows = [
    row("root", extra),
    ...children.map((c, i) => row("child" + i, c)),
  ];
  const list = vi.fn(
    async ({
      archived,
      limit,
      offset,
    }: {
      archived: boolean;
      limit: number;
      offset: number;
    }) =>
      rows
        .filter((r) =>
          archived ? r.archivedAt !== null : r.archivedAt === null,
        )
        .slice(offset, offset + limit),
  );
  const update = vi.fn(
    async ({
      threadId,
      parentThreadId,
    }: {
      threadId: string;
      parentThreadId: null;
    }) => {
      Object.assign(rows.find((t) => t.id === threadId)!, { parentThreadId });
      return {};
    },
  );
  const archive = vi.fn(async ({ threadId }: { threadId: string }) => {
    Object.assign(rows.find((t) => t.id === threadId)!, { archivedAt: now });
    return {};
  });
  const events = vi.fn(
    async (_args?: { threadId: string }) => [] as { createdAt: number }[],
  );
  const status = vi.fn(async () => ({
    outcome: "available",
    workspace: { workingTree: { hasUncommittedChanges: false } },
  }));
  const bb = {
    sdk: {
      threads: { list, update, archive, events: { list: events } },
      environments: { status },
    },
  } as unknown as BbPluginApi;
  return { bb, rows, list, update, archive, events, status };
}
it("dry-run never updates or archives even when prune can detach", async () => {
  const h = host({}, [{ parentThreadId: "root", latestAttentionAt: now }]);
  const r = await runOperation(h.bb, config, {
    now,
    targetId: "child0",
    dryRun: true,
  });
  expect(r.detachIds).toEqual(["child0"]);
  expect(r.actions).toHaveLength(1);
  expect(h.update).not.toHaveBeenCalled();
  expect(h.archive).not.toHaveBeenCalled();
});
it("config dryRun cannot be overridden false", async () => {
  const h = host();
  await runOperation(h.bb, { ...config, dryRun: true }, { now, dryRun: false });
  expect(h.archive).not.toHaveBeenCalled();
});
it("prune executes detach then archives ancestor while target stays live", async () => {
  const h = host({}, [{ parentThreadId: "root", latestAttentionAt: now }]);
  const r = await runOperation(h.bb, config, { now, targetId: "child0" });
  expect(r.archivedRoots).toBe(1);
  expect(h.rows[1].parentThreadId).toBeNull();
  expect(h.rows[1].archivedAt).toBeNull();
  expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(
    h.archive.mock.invocationCallOrder[0],
  );
});
it("background detaches active child before archive", async () => {
  const h = host({}, [{ parentThreadId: "root", latestAttentionAt: now }]);
  const r = await runOperation(
    h.bb,
    { ...config, detachActiveDescendants: true },
    { now },
  );
  expect(r.detached).toBe(1);
  expect(r.archivedRoots).toBe(1);
});
it("child turn events protect root even with old attention timestamp", async () => {
  const h = host({}, [{ parentThreadId: "root" }]);
  h.events.mockImplementation(async (args) =>
    args?.threadId === "child0" ? [{ createdAt: now }] : [],
  );
  expect(
    (await runOperation(h.bb, config, { now, dryRun: true })).actions,
  ).toEqual([]);
});
it("dirty and unavailable environment status protect the whole tree", async () => {
  const h = host();
  h.status.mockResolvedValue({
    outcome: "available",
    workspace: { workingTree: { hasUncommittedChanges: true } },
  });
  expect(
    (await runOperation(h.bb, config, { now, dryRun: true })).actions,
  ).toEqual([]);
  h.status.mockRejectedValue(new Error("offline"));
  expect(
    (await runOperation(h.bb, config, { now, dryRun: true })).actions,
  ).toEqual([]);
});
it("refuses archive if activity changes between preview and execution", async () => {
  const h = host();
  let n = 0;
  h.events.mockImplementation(async () =>
    ++n > 1 ? [{ createdAt: now }] : [],
  );
  await expect(runOperation(h.bb, config, { now })).rejects.toThrow(
    "inventory changed",
  );
  expect(h.archive).not.toHaveBeenCalled();
});
it("detach failure never falls through to archive", async () => {
  const h = host({}, [{ parentThreadId: "root", latestAttentionAt: now }]);
  h.update.mockRejectedValue(new Error("denied"));
  await expect(
    runOperation(h.bb, config, { now, targetId: "child0" }),
  ).rejects.toThrow("denied");
  expect(h.archive).not.toHaveBeenCalled();
});
it("pages through all threads including archived bridge nodes", async () => {
  const h = host();
  h.rows.push(
    ...Array.from({ length: 120 }, (_, i) => ({ ...h.rows[0], id: "t" + i })),
  );
  const r = await collect(h.bb, config, now);
  expect(r).toHaveLength(121);
  expect(h.list).toHaveBeenCalledWith(
    expect.objectContaining({ archived: false, offset: 100 }),
  );
});
it("rejects malformed settings before destructive actions", () => {
  for (const value of ["0", "NaN", "Infinity", "-5"])
    expect(() => parseDays(value)).toThrow();
  expect(parseDays("14")).toBe(14);
  expect(parseKeep('["thr_example"]')).toEqual(["thr_example"]);
  for (const value of ["{}", "[1]", '["anything"]'])
    expect(() => parseKeep(value)).toThrow();
});
it("unrelated active thread changes do not prevent an old independent root archive", async () => {
  const h = host();
  h.rows.push({ ...h.rows[0], id: "unrelated", latestAttentionAt: now });
  let n = 0;
  h.events.mockImplementation(async (args) =>
    args?.threadId === "unrelated" ? [{ createdAt: now + ++n }] : [],
  );
  expect((await runOperation(h.bb, config, { now })).archivedRoots).toBe(1);
});
it("a newly attached active descendant aborts before mutations", async () => {
  const h = host();
  let n = 0;
  const original = h.list.getMockImplementation()!;
  h.list.mockImplementation(async (args) => {
    if (++n === 3)
      h.rows.push({
        ...h.rows[0],
        id: "new-child",
        parentThreadId: "root",
        latestAttentionAt: now,
      });
    return original(args);
  });
  await expect(runOperation(h.bb, config, { now })).rejects.toThrow(
    "inventory changed",
  );
  expect(h.archive).not.toHaveBeenCalled();
  expect(h.update).not.toHaveBeenCalled();
});
it("workspace dirtied after detach blocks archive and leaves target safe", async () => {
  const h = host({}, [{ parentThreadId: "root", latestAttentionAt: now }]);
  let n = 0;
  h.status.mockImplementation(async () => ({
    outcome: "available",
    workspace: { workingTree: { hasUncommittedChanges: ++n >= 4 } },
  }));
  await expect(
    runOperation(h.bb, { ...config, detachActiveDescendants: true }, { now }),
  ).rejects.toThrow("Tree changed after detach");
  expect(h.update).toHaveBeenCalledOnce();
  expect(h.archive).not.toHaveBeenCalled();
});
