import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isUppercaseTitle } from "./policy.js";

export interface ThreadProtectionMeta {
  permanent: boolean;
  unarchiveCount: number;
  lastUnarchivedAt: number | null;
}

export async function loadThreadProtectionMeta(
  bb: BbPluginApi,
  ids: string[],
  signal?: AbortSignal,
): Promise<Map<string, ThreadProtectionMeta>> {
  const result = new Map<string, ThreadProtectionMeta>();
  for (let offset = 0; offset < ids.length; offset += 200) {
    signal?.throwIfAborted();
    const page = await bb.sdk.threads.experimental_listPluginMetadata({
      threadIds: ids.slice(offset, offset + 200),
      signal,
    });
    for (const row of page.threads) {
      const permanent = row.metadata.permanent;
      if (permanent !== undefined && typeof permanent !== "boolean")
        throw new Error(
          "Invalid permanent-thread metadata; no archive performed",
        );
      const unarchiveCount = row.metadata.unarchiveCount;
      if (
        unarchiveCount !== undefined &&
        (typeof unarchiveCount !== "number" ||
          !Number.isInteger(unarchiveCount) ||
          unarchiveCount < 0)
      )
        throw new Error(
          "Invalid unarchiveCount metadata; no retention action performed",
        );
      const lastUnarchivedAt = row.metadata.lastUnarchivedAt;
      if (
        lastUnarchivedAt !== undefined &&
        lastUnarchivedAt !== null &&
        (typeof lastUnarchivedAt !== "number" ||
          !Number.isFinite(lastUnarchivedAt) ||
          lastUnarchivedAt <= 0)
      )
        throw new Error(
          "Invalid lastUnarchivedAt metadata; no retention action performed",
        );
      result.set(row.threadId, {
        permanent: permanent === true,
        unarchiveCount: unarchiveCount ?? 0,
        lastUnarchivedAt: lastUnarchivedAt ?? null,
      });
    }
  }
  return result;
}

export async function permanentIds(
  bb: BbPluginApi,
  ids: string[],
  signal?: AbortSignal,
) {
  const meta = await loadThreadProtectionMeta(bb, ids, signal);
  const result = new Set<string>();
  for (const [id, entry] of meta) {
    if (entry.permanent) result.add(id);
  }
  return result;
}

export async function recordThreadUnarchived(
  bb: BbPluginApi,
  threadId: string,
  now = Date.now(),
): Promise<{ unarchiveCount: number; lastUnarchivedAt: number }> {
  const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
  const prev = metadata.unarchiveCount;
  const base =
    typeof prev === "number" && Number.isInteger(prev) && prev >= 0 ? prev : 0;
  const unarchiveCount = base + 1;
  await bb.sdk.threads.updatePluginMetadata({
    threadId,
    set: { unarchiveCount, lastUnarchivedAt: now },
  });
  return { unarchiveCount, lastUnarchivedAt: now };
}

/** One-time migration, completed before registering the sweeper. Retry partial writes. */
export async function migratePermanentThreads(bb: BbPluginApi, kept: string[]) {
  const key = "permanent-migration-v1";
  if (await bb.storage.kv.get(key)) return;
  let changed = 0;
  const candidates = [];
  for (let offset = 0; ; offset += 100) {
    const page = await bb.sdk.threads.list({
      archived: false, includeHidden: true, limit: 100, offset,
    });
    for (const thread of page) {
      if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
      if (!isUppercaseTitle(thread.title) &&
          !(thread.title ?? thread.titleFallback)?.startsWith("📌") &&
          !kept.includes(thread.id)) continue;
      candidates.push(thread);
    }
    if (page.length < 100) break;
    if (offset >= 100_000) throw new Error("Thread inventory exceeds migration safety limit");
  }
  for (const thread of candidates) {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: thread.id });
      // A previous partial migration or explicit user choice must survive a retry.
      if (typeof metadata.permanent === "boolean") continue;
      await bb.sdk.threads.updatePluginMetadata({threadId: thread.id, set: { permanent: true }});
      changed++;
  }
  await bb.storage.kv.set(key, { completedAt: Date.now(), changed });
}
