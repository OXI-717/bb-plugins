import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isUppercaseTitle } from "./policy.js";

export async function permanentIds(bb: BbPluginApi, ids: string[], signal?: AbortSignal) {
  const result = new Set<string>();
  for (let offset = 0; offset < ids.length; offset += 200) {
    signal?.throwIfAborted();
    const page = await bb.sdk.threads.experimental_listPluginMetadata({
      threadIds: ids.slice(offset, offset + 200), signal,
    });
    for (const row of page.threads) {
      const value = row.metadata.permanent;
      if (value !== undefined && typeof value !== "boolean")
        throw new Error("Invalid permanent-thread metadata; no archive performed");
      if (value === true) result.add(row.threadId);
    }
  }
  return result;
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
