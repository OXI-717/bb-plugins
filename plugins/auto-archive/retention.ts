// Retention execution: local archived thread-storage cleanup & verified automated export+delete.
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DAY, effectiveRetentionDays } from "./policy.js";
import { loadThreadProtectionMeta, type ThreadProtectionMeta } from "./permanent.js";
import { exportAndVerifyThread, validateExportDir } from "./export.js";
import {
  classifyAutomatedDeletion,
  ownerIds,
  planArchivedFileCleanup,
  planAutomatedExportDelete,
  retentionProtectionReason,
  type AutomatedDeletionReason,
  type RetentionConfig,
  type RetentionSnapshot,
} from "./retention-policy.js";

const THREAD_ID_RE = /^thr_[a-zA-Z0-9_-]+$/;
const REPORT_LIST_LIMIT = 100;

export interface LocalStorageMeasurement {
  exists: boolean;
  path: string | null;
  sizeBytes: number;
  fileCount: number;
  skippedReason?: string;
}

export interface FileCleanupItemReport {
  id: string;
  title: string;
  archivedAt: number;
  effectiveDays: number;
  sizeBytes: number;
  fileCount: number;
  cleared: boolean;
}

export interface ExportDeleteItemReport {
  id: string;
  title: string;
  reason: AutomatedDeletionReason;
  archivedAt: number;
  effectiveDays: number;
  deleted: boolean;
  archivePath?: string;
  sha256?: string;
  compressedBytes?: number;
  eventCount?: number;
}

export interface RetentionReport {
  dryRun: boolean;
  enableArchivedFileCleanup: boolean;
  enableAutomatedExportDelete: boolean;
  scannedArchived: number;
  limit: number;
  fileCleanup: {
    eligibleCount: number;
    candidateCount: number;
    clearedCount: number;
    reclaimableBytes: number;
    reclaimedBytes: number;
    skipped: Record<string, number>;
    items: FileCleanupItemReport[];
  };
  exportDelete: {
    eligibleCount: number;
    candidateCount: number;
    exportedCount: number;
    deletedCount: number;
    skipped: Record<string, number>;
    items: ExportDeleteItemReport[];
  };
  errors: string[];
  truncated: boolean;
}

/** Measure a thread's local storage directory without ever following symlinks. */
export async function measureLocalThreadStorage(
  storageRootDir: string,
  threadId: string,
  signal?: AbortSignal,
): Promise<LocalStorageMeasurement> {
  if (!THREAD_ID_RE.test(threadId)) {
    return {
      exists: false,
      path: null,
      sizeBytes: 0,
      fileCount: 0,
      skippedReason: "invalid-thread-id",
    };
  }
  let baseReal: string;
  try {
    baseReal = await realpath(storageRootDir);
  } catch {
    return {
      exists: false,
      path: null,
      sizeBytes: 0,
      fileCount: 0,
      skippedReason: "storage-root-missing",
    };
  }
  const targetPath = path.join(baseReal, threadId);
  let targetStat;
  try {
    targetStat = await lstat(targetPath);
  } catch {
    return { exists: false, path: targetPath, sizeBytes: 0, fileCount: 0 };
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    return {
      exists: false,
      path: null,
      sizeBytes: 0,
      fileCount: 0,
      skippedReason: "not-a-directory",
    };
  }
  const targetReal = await realpath(targetPath);
  if (
    targetReal !== path.join(baseReal, threadId) ||
    !targetReal.startsWith(baseReal + path.sep)
  ) {
    return {
      exists: false,
      path: null,
      sizeBytes: 0,
      fileCount: 0,
      skippedReason: "path-escape",
    };
  }

  let sizeBytes = 0;
  let fileCount = 0;
  const stack = [targetReal];
  while (stack.length > 0) {
    signal?.throwIfAborted();
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      let st;
      try {
        st = await lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        fileCount++;
        sizeBytes += st.size;
      } else if (st.isDirectory()) {
        stack.push(full);
      } else {
        fileCount++;
        sizeBytes += st.size;
      }
    }
  }

  return {
    exists: fileCount > 0,
    path: targetReal,
    sizeBytes,
    fileCount,
  };
}

async function listAllThreads(bb: BbPluginApi, signal?: AbortSignal) {
  const rows = new Map<
    string,
    Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number]
  >();
  for (const archived of [false, true]) {
    for (let offset = 0; ; offset += 100) {
      signal?.throwIfAborted();
      const page = await bb.sdk.threads.list({
        archived,
        includeHidden: true,
        limit: 100,
        offset,
        signal,
      });
      for (const row of page) rows.set(row.id, row);
      if (page.length < 100) break;
      if (offset >= 100_000) {
        throw new Error(
          "Thread inventory exceeds safety limit; no retention performed",
        );
      }
    }
  }
  return rows;
}

function toRetentionSnapshots(
  rows: ReadonlyMap<
    string,
    Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number]
  >,
  meta: ReadonlyMap<string, ThreadProtectionMeta>,
): RetentionSnapshot[] {
  const out: RetentionSnapshot[] = [];
  for (const t of rows.values()) {
    const m = meta.get(t.id);
    out.push({
      id: t.id,
      title: t.title,
      titleFallback: t.titleFallback,
      parentThreadId: t.parentThreadId,
      lifecycleOwnerThreadId: t.lifecycleOwnerThreadId,
      sourceThreadId: t.sourceThreadId,
      visibility: t.visibility,
      originKind: t.originKind ?? null,
      originPluginId: t.originPluginId ?? null,
      archivedAt: t.archivedAt,
      deletedAt: t.deletedAt,
      pinnedAt: t.pinnedAt,
      status: t.status,
      busy:
        t.queuedWork !== "none" ||
        t.hasPendingInteraction ||
        Object.values(t.activity).some((count) => count > 0),
      permanent: m?.permanent === true,
      unarchiveCount: m?.unarchiveCount ?? 0,
      lastUnarchivedAt: m?.lastUnarchivedAt ?? null,
      environmentId: t.environmentId,
      environmentHostId: t.environmentHostId ?? null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function parseFreshMeta(
  raw: Record<string, unknown>,
): ThreadProtectionMeta {
  const permanent = raw.permanent;
  if (permanent !== undefined && typeof permanent !== "boolean") {
    throw new Error("Invalid permanent metadata during revalidation");
  }
  const unarchiveCount = raw.unarchiveCount;
  if (
    unarchiveCount !== undefined &&
    (typeof unarchiveCount !== "number" ||
      !Number.isInteger(unarchiveCount) ||
      unarchiveCount < 0)
  ) {
    throw new Error("Invalid unarchiveCount metadata during revalidation");
  }
  const lastUnarchivedAt = raw.lastUnarchivedAt;
  if (
    lastUnarchivedAt !== undefined &&
    lastUnarchivedAt !== null &&
    (typeof lastUnarchivedAt !== "number" ||
      !Number.isFinite(lastUnarchivedAt) ||
      lastUnarchivedAt <= 0)
  ) {
    throw new Error("Invalid lastUnarchivedAt metadata during revalidation");
  }
  return {
    permanent: permanent === true,
    unarchiveCount: unarchiveCount ?? 0,
    lastUnarchivedAt: lastUnarchivedAt ?? null,
  };
}

async function revalidateArchivedThread(
  bb: BbPluginApi,
  threadId: string,
  config: RetentionConfig,
  baseDays: number,
  now: number,
  signal?: AbortSignal,
) {
  const [freshThread, freshRawMeta] = await Promise.all([
    bb.sdk.threads.get({ threadId, signal }),
    bb.sdk.threads.getPluginMetadata({ threadId, signal }),
  ]);
  const freshMeta = parseFreshMeta(freshRawMeta);
  const displayStatus = freshThread.runtime?.displayStatus ?? freshThread.status;
  const busy =
    freshThread.queuedMessageCount > 0 ||
    freshThread.activeBackgroundAgentCount > 0 ||
    !["idle", "error"].includes(displayStatus);
  const reason = retentionProtectionReason(
    {
      id: freshThread.id,
      title: freshThread.title,
      titleFallback: freshThread.titleFallback,
      archivedAt: freshThread.archivedAt,
      deletedAt: freshThread.deletedAt,
      pinnedAt: freshThread.pinnedAt,
      status: freshThread.status,
      busy,
      permanent: freshMeta.permanent,
    },
    config,
  );
  if (reason) {
    return { ok: false as const, reason };
  }
  const effectiveDays = effectiveRetentionDays(
    baseDays,
    freshMeta.unarchiveCount,
    config.unarchiveGraceMultiplier,
  );
  if (now - freshThread.archivedAt! < effectiveDays * DAY) {
    return { ok: false as const, reason: "within-retention-window" };
  }
  return { ok: true as const, thread: freshThread, meta: freshMeta };
}

/**
 * Re-checks, against fresh owner state, that a thread is still eligible for
 * automated deletion. Owners missing from the initial inventory stay "missing";
 * any owner that was known must be re-read, and a failed read fails closed.
 */
async function revalidateDeletionOwners(
  bb: BbPluginApi,
  thread: {
    parentThreadId: string | null;
    lifecycleOwnerThreadId: string | null;
    sourceThreadId: string | null;
    visibility: "visible" | "hidden";
    originPluginId?: string | null;
  },
  knownThreadIds: ReadonlySet<string>,
  config: RetentionConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  const fresh = {
    parentThreadId: thread.parentThreadId ?? null,
    lifecycleOwnerThreadId: thread.lifecycleOwnerThreadId ?? null,
    sourceThreadId: thread.sourceThreadId ?? null,
    visibility: thread.visibility,
    originPluginId: thread.originPluginId ?? null,
  };
  const owners = new Map<string, { archivedAt: number | null; deletedAt: number | null }>();
  for (const ownerId of ownerIds(fresh)) {
    if (!knownThreadIds.has(ownerId)) continue;
    try {
      const owner = await bb.sdk.threads.get({ threadId: ownerId, signal });
      owners.set(ownerId, {
        archivedAt: owner.archivedAt,
        deletedAt: owner.deletedAt,
      });
    } catch {
      return "owner-recheck-failed";
    }
  }
  return classifyAutomatedDeletion(fresh, owners, config)
    ? null
    : "owner-live-or-reclassified";
}

export async function runRetention(
  bb: BbPluginApi,
  config: RetentionConfig & { dryRun: boolean },
  options: {
    dryRun?: boolean;
    limit?: number;
    now?: number;
    dataDir?: string;
    signal?: AbortSignal;
  } = {},
): Promise<RetentionReport> {
  const now = options.now ?? Date.now();
  const dryRun = config.dryRun || options.dryRun === true;
  const limit = Math.max(
    1,
    Math.min(options.limit ?? config.retentionMaxPerRun, 500),
  );
  const rows = await listAllThreads(bb, options.signal);
  const protection = await loadThreadProtectionMeta(
    bb,
    [...rows.keys()],
    options.signal,
  );
  const snapshots = toRetentionSnapshots(rows, protection);
  const scannedArchived = snapshots.filter(
    (t) => t.archivedAt !== null && t.deletedAt === null,
  ).length;

  const filePlan = planArchivedFileCleanup(snapshots, config, now);
  const deletePlan = planAutomatedExportDelete(snapshots, config, now);
  const knownThreadIds = new Set(snapshots.map((t) => t.id));
  const errors: string[] = [];

  // 1. Archived thread-storage cleanup (never touches conversation history in bb.db).
  const dataDir =
    options.dataDir ??
    (bb.server as { experimental_dataDir?: string } | undefined)
      ?.experimental_dataDir;
  const storageRootDir = dataDir ? path.join(dataDir, "thread-storage") : null;
  const fileItems: FileCleanupItemReport[] = [];
  let reclaimableBytes = 0;
  let reclaimedBytes = 0;
  let clearedCount = 0;
  const fileSkipped = { ...filePlan.skipped };
  const bumpFileSkipped = (reason: string) => {
    fileSkipped[reason] = (fileSkipped[reason] ?? 0) + 1;
  };
  let fileLoopHitLimit = false;

  if (!storageRootDir) {
    bumpFileSkipped("server-data-dir-unavailable");
  } else {
    for (const candidate of filePlan.candidates) {
      if (fileItems.length >= limit) {
        fileLoopHitLimit = true;
        break;
      }
      options.signal?.throwIfAborted();
      const measured = await measureLocalThreadStorage(
        storageRootDir,
        candidate.id,
        options.signal,
      );
      if (measured.skippedReason) {
        bumpFileSkipped(measured.skippedReason);
        continue;
      }
      if (!measured.exists || !measured.path) {
        continue;
      }
      // If thread has an environment, verify its storage location resolves to this local dir.
      if (
        candidate.environmentId !== null &&
        typeof bb.sdk.threads.storageLocation === "function"
      ) {
        try {
          const loc = await bb.sdk.threads.storageLocation({
            threadId: candidate.id,
            signal: options.signal,
          });
          if (path.resolve(loc.storageRootPath) !== path.resolve(measured.path)) {
            bumpFileSkipped("remote-host-storage");
            continue;
          }
        } catch {
          bumpFileSkipped("storage-location-unavailable");
          continue;
        }
      }

      reclaimableBytes += measured.sizeBytes;
      let cleared = false;
      if (!dryRun && config.enableArchivedFileCleanup) {
        try {
          const recheck = await revalidateArchivedThread(
            bb,
            candidate.id,
            config,
            config.clearArchivedFilesAfterDays,
            now,
            options.signal,
          );
          if (!recheck.ok) {
            bumpFileSkipped(`recheck-${recheck.reason}`);
            continue;
          }
          const st = await lstat(measured.path);
          if (st.isSymbolicLink() || !st.isDirectory()) {
            bumpFileSkipped("not-a-directory");
            continue;
          }
          await rm(measured.path, { recursive: true, force: true });
          cleared = true;
          clearedCount++;
          reclaimedBytes += measured.sizeBytes;
        } catch (error) {
          errors.push(
            `file-cleanup ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      fileItems.push({
        id: candidate.id,
        title: candidate.title.slice(0, 200),
        archivedAt: candidate.archivedAt,
        effectiveDays: candidate.effectiveDays,
        sizeBytes: measured.sizeBytes,
        fileCount: measured.fileCount,
        cleared,
      });
    }
  }

  // 2. Automated/child thread export + verified delete (bottom-up leaves first).
  const deleteSkipped = { ...deletePlan.skipped };
  const bumpDeleteSkipped = (reason: string) => {
    deleteSkipped[reason] = (deleteSkipped[reason] ?? 0) + 1;
  };
  const selectedDeletes = deletePlan.candidates.slice(0, limit);
  const deleteItems: ExportDeleteItemReport[] = [];
  let exportedCount = 0;
  let deletedCount = 0;

  const snapshotById = new Map(snapshots.map((s) => [s.id, s]));
  const failedOrSkippedIds = new Set<string>();
  const hasBlockedDescendant = (ownerId: string): boolean => {
    for (const failedId of failedOrSkippedIds) {
      const child = snapshotById.get(failedId);
      if (!child) continue;
      if (
        child.parentThreadId === ownerId ||
        child.lifecycleOwnerThreadId === ownerId ||
        (child.visibility === "hidden" && child.sourceThreadId === ownerId)
      ) {
        return true;
      }
    }
    return false;
  };

  let validatedExportDir = "";
  if (!dryRun && config.enableAutomatedExportDelete) {
    try {
      validatedExportDir = validateExportDir(config.exportDir);
      if (!validatedExportDir) {
        errors.push(
          "export-delete: exportDir is empty; refusing to delete any thread without verified export",
        );
      }
    } catch (error) {
      errors.push(
        `export-delete: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  for (const candidate of selectedDeletes) {
    options.signal?.throwIfAborted();
    if (dryRun || !config.enableAutomatedExportDelete || !validatedExportDir) {
      deleteItems.push({
        id: candidate.id,
        title: candidate.title.slice(0, 200),
        reason: candidate.reason,
        archivedAt: candidate.archivedAt,
        effectiveDays: candidate.effectiveDays,
        deleted: false,
      });
      continue;
    }

    if (hasBlockedDescendant(candidate.id)) {
      failedOrSkippedIds.add(candidate.id);
      bumpDeleteSkipped("descendant-failed");
      continue;
    }

    try {
      const preCheck = await revalidateArchivedThread(
        bb,
        candidate.id,
        config,
        config.exportDeleteAfterDays,
        now,
        options.signal,
      );
      if (!preCheck.ok) {
        failedOrSkippedIds.add(candidate.id);
        bumpDeleteSkipped(`recheck-${preCheck.reason}`);
        continue;
      }
      const preOwners = await revalidateDeletionOwners(
        bb,
        preCheck.thread,
        knownThreadIds,
        config,
        options.signal,
      );
      if (preOwners) {
        failedOrSkippedIds.add(candidate.id);
        bumpDeleteSkipped(`recheck-${preOwners}`);
        continue;
      }
      const preChildren = await bb.sdk.threads.childSummary({
        threadId: candidate.id,
        signal: options.signal,
      });
      if (preChildren.nonDeletedChildCount > 0) {
        failedOrSkippedIds.add(candidate.id);
        bumpDeleteSkipped("has-non-deleted-children");
        continue;
      }

      const exported = await exportAndVerifyThread(
        bb,
        preCheck.thread as unknown as Record<string, unknown> & {
          id: string;
          archivedAt: number | null;
        },
        preCheck.meta,
        validatedExportDir,
        options.signal,
        now,
      );
      exportedCount++;

      // Final revalidation right before destructive delete.
      const postCheck = await revalidateArchivedThread(
        bb,
        candidate.id,
        config,
        config.exportDeleteAfterDays,
        now,
        options.signal,
      );
      if (
        !postCheck.ok ||
        postCheck.meta.unarchiveCount !== preCheck.meta.unarchiveCount
      ) {
        failedOrSkippedIds.add(candidate.id);
        bumpDeleteSkipped("changed-during-export");
        continue;
      }
      const postOwners = await revalidateDeletionOwners(
        bb,
        postCheck.thread,
        knownThreadIds,
        config,
        options.signal,
      );
      if (postOwners) {
        failedOrSkippedIds.add(candidate.id);
        bumpDeleteSkipped(`owner-changed-during-export`);
        continue;
      }
      const postChildren = await bb.sdk.threads.childSummary({
        threadId: candidate.id,
        signal: options.signal,
      });
      if (postChildren.nonDeletedChildCount > 0) {
        failedOrSkippedIds.add(candidate.id);
        bumpDeleteSkipped("child-added-during-export");
        continue;
      }

      await bb.sdk.threads.delete({
        threadId: candidate.id,
        childThreadsConfirmed: false,
      });
      deletedCount++;
      deleteItems.push({
        id: candidate.id,
        title: candidate.title.slice(0, 200),
        reason: candidate.reason,
        archivedAt: candidate.archivedAt,
        effectiveDays: candidate.effectiveDays,
        deleted: true,
        archivePath: exported.archivePath,
        sha256: exported.sha256,
        compressedBytes: exported.compressedBytes,
        eventCount: exported.eventCount,
      });
    } catch (error) {
      failedOrSkippedIds.add(candidate.id);
      errors.push(
        `export-delete ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return {
    dryRun,
    enableArchivedFileCleanup: config.enableArchivedFileCleanup,
    enableAutomatedExportDelete: config.enableAutomatedExportDelete,
    scannedArchived,
    limit,
    fileCleanup: {
      eligibleCount: filePlan.candidates.length,
      candidateCount: fileItems.length,
      clearedCount,
      reclaimableBytes,
      reclaimedBytes,
      skipped: fileSkipped,
      items: fileItems.slice(0, REPORT_LIST_LIMIT),
    },
    exportDelete: {
      eligibleCount: deletePlan.candidates.length,
      candidateCount: deleteItems.length,
      exportedCount,
      deletedCount,
      skipped: deleteSkipped,
      items: deleteItems.slice(0, REPORT_LIST_LIMIT),
    },
    errors: errors.slice(0, REPORT_LIST_LIMIT),
    truncated:
      fileLoopHitLimit ||
      fileItems.length > REPORT_LIST_LIMIT ||
      deleteItems.length > REPORT_LIST_LIMIT ||
      errors.length > REPORT_LIST_LIMIT ||
      deletePlan.candidates.length > limit,
  };
}
