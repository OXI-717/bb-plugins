import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DAY } from "./policy.js";
import { EXPORT_FORMAT, validateExportDir } from "./export.js";
import { DEFAULT_AUTOMATED_ORIGIN_PLUGINS, type RetentionConfig } from "./retention-policy.js";
import { measureLocalThreadStorage, runRetention } from "./retention.js";

const NOW = 100 * DAY;
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

interface MockRow {
  id: string;
  title: string | null;
  titleFallback: string | null;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  sourceThreadId: string | null;
  visibility: "visible" | "hidden";
  originKind: "fork" | null;
  originPluginId: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
  pinnedAt: number | null;
  status: string;
  queuedWork: "none" | "waiting" | "failed";
  queuedMessageCount: number;
  activeBackgroundAgentCount: number;
  hasPendingInteraction: boolean;
  activity: {
    activeBackgroundAgentCount: number;
    activeBackgroundCommandCount: number;
    activeGoalCount: number;
    activePlanModeCount: number;
    activeWorkflowCount: number;
  };
  environmentId: string | null;
  environmentHostId: string | null;
}

function makeRow(id: string, overrides: Partial<MockRow> = {}): MockRow {
  return {
    id,
    title: id,
    titleFallback: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    visibility: "visible",
    originKind: null,
    originPluginId: null,
    archivedAt: NOW - 40 * DAY,
    deletedAt: null,
    pinnedAt: null,
    status: "idle",
    queuedWork: "none",
    queuedMessageCount: 0,
    activeBackgroundAgentCount: 0,
    hasPendingInteraction: false,
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    environmentId: null,
    environmentHostId: null,
    ...overrides,
  };
}

function makeHarness(
  rows: MockRow[],
  options: {
    dataDir: string;
    meta?: Record<string, Record<string, unknown>>;
    eventsByThread?: Record<string, { id: string; seq: number; threadId: string; type: string; createdAt: number; data: Record<string, unknown> }[]>;
    storageLocations?: Record<string, { hostId: string; storageRootPath: string }>;
    childCounts?: Record<string, number>;
    onBeforeGet?: (threadId: string, callIndex: number) => void;
  },
) {
  const rowMap = new Map(rows.map((r) => [r.id, r]));
  const metaMap = new Map(Object.entries(options.meta ?? {}));
  const deleteCalls: { threadId: string; childThreadsConfirmed: boolean }[] = [];
  const getCalls = new Map<string, number>();

  const bb = {
    server: { experimental_dataDir: options.dataDir },
    sdk: {
      threads: {
        list: vi.fn(async ({ archived, offset = 0 }: { archived?: boolean; offset?: number }) => {
          if (offset > 0) return [];
          return [...rowMap.values()].filter((r) =>
            archived ? r.archivedAt !== null : r.archivedAt === null,
          );
        }),
        get: vi.fn(async ({ threadId }: { threadId: string }) => {
          const count = (getCalls.get(threadId) ?? 0) + 1;
          getCalls.set(threadId, count);
          options.onBeforeGet?.(threadId, count);
          const row = rowMap.get(threadId);
          if (!row) throw new Error(`Missing thread ${threadId}`);
          return row;
        }),
        getPluginMetadata: vi.fn(async ({ threadId }: { threadId: string }) => {
          return metaMap.get(threadId) ?? {};
        }),
        experimental_listPluginMetadata: vi.fn(
          async ({ threadIds }: { threadIds: string[] }) => ({
            threads: threadIds
              .filter((id) => metaMap.has(id))
              .map((threadId) => ({ threadId, metadata: metaMap.get(threadId)! })),
          }),
        ),
        storageLocation: vi.fn(async ({ threadId }: { threadId: string }) => {
          const loc = options.storageLocations?.[threadId];
          if (!loc) throw new Error("No storage location");
          return loc;
        }),
        childSummary: vi.fn(async ({ threadId }: { threadId: string }) => ({
          nonDeletedChildCount: options.childCounts?.[threadId] ?? 0,
          unarchivedDescendantCount: 0,
        })),
        events: {
          list: vi.fn(
            async ({
              threadId,
              afterSeq,
              limit,
            }: {
              threadId: string;
              afterSeq?: string;
              limit?: string;
            }) => {
              const all = options.eventsByThread?.[threadId] ?? [];
              const minSeq = afterSeq !== undefined ? Number(afterSeq) : -Infinity;
              const pageLimit = Number(limit ?? "200");
              return all.filter((e) => e.seq > minSeq).slice(0, pageLimit);
            },
          ),
        },
        delete: vi.fn(
          async (args: { threadId: string; childThreadsConfirmed: boolean }) => {
            deleteCalls.push(args);
            rowMap.delete(args.threadId);
            return { ok: true as const };
          },
        ),
      },
    },
  } as unknown as BbPluginApi;

  return { bb, rowMap, metaMap, deleteCalls };
}

function makeConfig(
  overrides: Partial<RetentionConfig & { dryRun: boolean }> = {},
): RetentionConfig & { dryRun: boolean } {
  return {
    dryRun: false,
    keepThreadIds: [],
    unarchiveGraceMultiplier: 2,
    enableArchivedFileCleanup: false,
    clearArchivedFilesAfterDays: 14,
    enableAutomatedExportDelete: false,
    exportDeleteAfterDays: 30,
    exportDir: "",
    automatedOriginPluginIds: [...DEFAULT_AUTOMATED_ORIGIN_PLUGINS],
    retentionMaxPerRun: 50,
    ...overrides,
  };
}

describe("validateExportDir", () => {
  it("rejects relative paths, root, and parent traversal", () => {
    expect(validateExportDir("")).toBe("");
    expect(() => validateExportDir("relative/path")).toThrow();
    expect(() => validateExportDir("/")).toThrow();
    expect(() => validateExportDir("/tmp/a/../b")).toThrow();
    expect(validateExportDir("/tmp/bb-exports")).toBe("/tmp/bb-exports");
  });
});

describe("measureLocalThreadStorage", () => {
  it("refuses symlinked thread storage directories", async () => {
    const dataDir = await makeTempDir("aa-sym-");
    const tsRoot = path.join(dataDir, "thread-storage");
    const outside = await makeTempDir("aa-outside-");
    await mkdir(tsRoot, { recursive: true });
    await writeFile(path.join(outside, "secret.txt"), "keep me");
    await symlink(outside, path.join(tsRoot, "thr_symlink"));

    const m = await measureLocalThreadStorage(tsRoot, "thr_symlink");
    expect(m.exists).toBe(false);
    expect(m.skippedReason).toBe("not-a-directory");
  });
});

describe("runRetention", () => {
  it("previews file cleanup and export+delete without mutating anything when opt-in flags are false", async () => {
    const dataDir = await makeTempDir("aa-data-");
    const tsDir = path.join(dataDir, "thread-storage", "thr_manual_old");
    await mkdir(tsDir, { recursive: true });
    await writeFile(path.join(tsDir, "blob.bin"), Buffer.alloc(1024, 1));

    const { bb, deleteCalls } = makeHarness(
      [
        makeRow("thr_manual_old", { archivedAt: NOW - 20 * DAY }),
        makeRow("thr_wf_old", {
          originPluginId: "workflows",
          archivedAt: NOW - 45 * DAY,
        }),
      ],
      { dataDir },
    );

    const report = await runRetention(
      bb,
      makeConfig({
        dryRun: false,
        enableArchivedFileCleanup: false,
        enableAutomatedExportDelete: false,
      }),
      { now: NOW },
    );

    expect(report.fileCleanup.candidateCount).toBe(1);
    expect(report.fileCleanup.clearedCount).toBe(0);
    expect(report.fileCleanup.reclaimableBytes).toBe(1024);
    expect(report.exportDelete.candidateCount).toBe(1);
    expect(report.exportDelete.deletedCount).toBe(0);
    expect(deleteCalls).toHaveLength(0);
    // File must still exist on disk
    expect((await readFile(path.join(tsDir, "blob.bin"))).byteLength).toBe(1024);
  });

  it("clears local archived thread-storage files when enabled while skipping permanent and remote-host threads", async () => {
    const dataDir = await makeTempDir("aa-clean-");
    const localDir = path.join(dataDir, "thread-storage", "thr_local_old");
    const permDir = path.join(dataDir, "thread-storage", "thr_perm_old");
    const remoteDir = path.join(dataDir, "thread-storage", "thr_remote_old");
    await mkdir(localDir, { recursive: true });
    await mkdir(permDir, { recursive: true });
    await mkdir(remoteDir, { recursive: true });
    await writeFile(path.join(localDir, "artifact.dat"), Buffer.alloc(2048, 2));
    await writeFile(path.join(permDir, "keep.dat"), Buffer.alloc(512, 3));
    await writeFile(path.join(remoteDir, "other.dat"), Buffer.alloc(512, 4));

    const { bb } = makeHarness(
      [
        makeRow("thr_local_old", {
          archivedAt: NOW - 20 * DAY,
          environmentId: "env_local",
        }),
        makeRow("thr_perm_old", { archivedAt: NOW - 40 * DAY }),
        makeRow("thr_remote_old", {
          archivedAt: NOW - 40 * DAY,
          environmentId: "env_remote",
        }),
      ],
      {
        dataDir,
        meta: { thr_perm_old: { permanent: true } },
        storageLocations: {
          thr_local_old: { hostId: "host_local", storageRootPath: localDir },
          thr_remote_old: {
            hostId: "host_remote",
            storageRootPath: "/remote-host/data/thread-storage/thr_remote_old",
          },
        },
      },
    );

    const report = await runRetention(
      bb,
      makeConfig({
        dryRun: false,
        enableArchivedFileCleanup: true,
      }),
      { now: NOW },
    );

    expect(report.fileCleanup.clearedCount).toBe(1);
    expect(report.fileCleanup.reclaimedBytes).toBe(2048);
    expect(report.fileCleanup.skipped["remote-host-storage"]).toBe(1);
    expect(report.fileCleanup.skipped.permanent).toBe(1);
    expect((await measureLocalThreadStorage(path.join(dataDir, "thread-storage"), "thr_local_old")).exists).toBe(false);
    expect((await measureLocalThreadStorage(path.join(dataDir, "thread-storage"), "thr_perm_old")).exists).toBe(true);
    expect((await measureLocalThreadStorage(path.join(dataDir, "thread-storage"), "thr_remote_old")).exists).toBe(true);
  });

  it("exports verified .jsonl.gz + .sha256 archives before deleting automated threads bottom-up", async () => {
    const dataDir = await makeTempDir("aa-exp-data-");
    const exportDir = await makeTempDir("aa-exp-out-");
    const archivedAt = Date.UTC(2026, 7, 15, 12, 0, 0);
    const now = archivedAt + 40 * DAY;

    const { bb, deleteCalls } = makeHarness(
      [
        makeRow("thr_wf_parent", {
          originPluginId: "workflows",
          archivedAt,
        }),
        makeRow("thr_wf_child", {
          originPluginId: "workflows",
          parentThreadId: "thr_wf_parent",
          archivedAt,
        }),
        makeRow("thr_manual_keep", {
          originPluginId: null,
          archivedAt,
        }),
      ],
      {
        dataDir,
        eventsByThread: {
          thr_wf_child: [
            { id: "ev1", seq: 1, threadId: "thr_wf_child", type: "turn/started", createdAt: archivedAt - 1000, data: { msg: "hello" } },
            { id: "ev2", seq: 2, threadId: "thr_wf_child", type: "turn/completed", createdAt: archivedAt - 500, data: { ok: true } },
          ],
          thr_wf_parent: [
            { id: "ev3", seq: 1, threadId: "thr_wf_parent", type: "turn/started", createdAt: archivedAt - 2000, data: {} },
          ],
        },
      },
    );

    const report = await runRetention(
      bb,
      makeConfig({
        dryRun: false,
        enableAutomatedExportDelete: true,
        exportDir,
      }),
      { now },
    );

    expect(report.errors).toEqual([]);
    expect(report.exportDelete.exportedCount).toBe(2);
    expect(report.exportDelete.deletedCount).toBe(2);
    // Child deleted BEFORE parent, both with childThreadsConfirmed: false!
    expect(deleteCalls).toEqual([
      { threadId: "thr_wf_child", childThreadsConfirmed: false },
      { threadId: "thr_wf_parent", childThreadsConfirmed: false },
    ]);

    // Verify exported archive & checksum on disk
    const childArchive = path.join(exportDir, "2026-08", "thr_wf_child.jsonl.gz");
    const childSha = (await readFile(`${childArchive}.sha256`, "utf8")).trim();
    expect(childSha).toMatch(/^[a-f0-9]{64}  thr_wf_child\.jsonl\.gz$/);
    const lines = gunzipSync(await readFile(childArchive))
      .toString("utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0].format).toBe(EXPORT_FORMAT);
    expect(lines[0].eventCount).toBe(2);
    expect(lines[1].seq).toBe(1);
    expect(lines[2].seq).toBe(2);
  });

  it("refuses deletion if exportDir is empty, thread is unarchived during export, or childSummary is non-zero", async () => {
    const dataDir = await makeTempDir("aa-abort-data-");
    const exportDir = await makeTempDir("aa-abort-out-");

    // Case 1: empty exportDir
    const h1 = makeHarness(
      [makeRow("thr_wf_1", { originPluginId: "workflows", archivedAt: NOW - 45 * DAY })],
      { dataDir },
    );
    const r1 = await runRetention(
      h1.bb,
      makeConfig({ dryRun: false, enableAutomatedExportDelete: true, exportDir: "" }),
      { now: NOW },
    );
    expect(r1.exportDelete.deletedCount).toBe(0);
    expect(r1.errors[0]).toContain("exportDir is empty");
    expect(h1.deleteCalls).toHaveLength(0);

    // Case 2: thread unarchived mid-export (second get() sees archivedAt === null)
    const row2 = makeRow("thr_wf_2", { originPluginId: "workflows", archivedAt: NOW - 45 * DAY });
    const h2 = makeHarness([row2], {
      dataDir,
      onBeforeGet: (_id, callIndex) => {
        if (callIndex === 2) row2.archivedAt = null;
      },
    });
    const r2 = await runRetention(
      h2.bb,
      makeConfig({ dryRun: false, enableAutomatedExportDelete: true, exportDir }),
      { now: NOW },
    );
    expect(r2.exportDelete.exportedCount).toBe(1);
    expect(r2.exportDelete.deletedCount).toBe(0);
    expect(r2.exportDelete.skipped["changed-during-export"]).toBe(1);
    expect(h2.deleteCalls).toHaveLength(0);

    // Case 3: non-deleted children reported by server
    const h3 = makeHarness(
      [makeRow("thr_wf_3", { originPluginId: "workflows", archivedAt: NOW - 45 * DAY })],
      { dataDir, childCounts: { thr_wf_3: 1 } },
    );
    const r3 = await runRetention(
      h3.bb,
      makeConfig({ dryRun: false, enableAutomatedExportDelete: true, exportDir }),
      { now: NOW },
    );
    expect(r3.exportDelete.deletedCount).toBe(0);
    expect(r3.exportDelete.skipped["has-non-deleted-children"]).toBe(1);
    expect(h3.deleteCalls).toHaveLength(0);
  });
});
