import type { BbPluginApi } from '@get-bb/plugin-sdk';

const LEGACY_ISSUE_DRAFT_REQUEST_PREFIX = 'issue-draft:request:';
const LEGACY_ISSUE_DRAFT_THREAD_PREFIX = 'issue-draft:thread:';
const LEGACY_ISSUE_DRAFT_CANCELLATION_PREFIX = 'issue-draft:cancellation:';
const LEGACY_ISSUE_DRAFT_TITLE = 'Draft Taskboard issue';
const LEGACY_ISSUE_DRAFT_PAGE_SIZE = 200;

interface LegacyIssueDraftThread {
  id: string;
  title: string | null;
  titleFallback: string | null;
  originPluginId: string | null;
  visibility: 'visible' | 'hidden';
  archivedAt: number | null;
}

export function isLegacyIssueDraftHelper(
  thread: LegacyIssueDraftThread,
  pluginId: string
): boolean {
  return (
    thread.originPluginId === pluginId &&
    thread.visibility === 'hidden' &&
    (thread.title === LEGACY_ISSUE_DRAFT_TITLE ||
      thread.titleFallback === LEGACY_ISSUE_DRAFT_TITLE)
  );
}

async function listLegacyIssueDraftHelpers(
  bb: BbPluginApi,
  archived: boolean,
  candidateIds: ReadonlySet<string>
): Promise<Map<string, LegacyIssueDraftThread>> {
  const helpers = new Map<string, LegacyIssueDraftThread>();
  for (let offset = 0; ; offset += LEGACY_ISSUE_DRAFT_PAGE_SIZE) {
    const page = await bb.sdk.threads.list({
      archived,
      includeHidden: true,
      originPluginId: bb.pluginId,
      limit: LEGACY_ISSUE_DRAFT_PAGE_SIZE,
      offset
    });
    for (const thread of page) {
      if (candidateIds.has(thread.id)) helpers.set(thread.id, thread);
    }
    if (page.length < LEGACY_ISSUE_DRAFT_PAGE_SIZE) break;
  }
  return helpers;
}

function helperIdFromLegacyRecord(value: unknown): string | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('status' in value) ||
    value.status !== 'running' ||
    !('helperThreadId' in value) ||
    typeof value.helperThreadId !== 'string' ||
    value.helperThreadId.trim().length === 0
  ) {
    return null;
  }
  return value.helperThreadId;
}

export async function cleanupLegacyIssueDraftHelpers(
  bb: BbPluginApi
): Promise<void> {
  const [requestKeys, threadKeys, cancellationKeys] = await Promise.all([
    bb.storage.kv.list(LEGACY_ISSUE_DRAFT_REQUEST_PREFIX),
    bb.storage.kv.list(LEGACY_ISSUE_DRAFT_THREAD_PREFIX),
    bb.storage.kv.list(LEGACY_ISSUE_DRAFT_CANCELLATION_PREFIX)
  ]);
  const candidateIds = new Set<string>();
  for (const key of requestKeys) {
    const helperId = helperIdFromLegacyRecord(
      await bb.storage.kv.get<unknown>(key)
    );
    if (helperId !== null) candidateIds.add(helperId);
  }
  for (const key of threadKeys) {
    const helperId = key.slice(LEGACY_ISSUE_DRAFT_THREAD_PREFIX.length);
    if (helperId.length > 0) candidateIds.add(helperId);
  }

  const helpers = new Map<string, LegacyIssueDraftThread>();
  if (candidateIds.size > 0) {
    for (const archived of [false, true]) {
      for (const [id, thread] of await listLegacyIssueDraftHelpers(
        bb,
        archived,
        candidateIds
      )) {
        helpers.set(id, thread);
      }
    }
  }

  for (const thread of helpers.values()) {
    if (!isLegacyIssueDraftHelper(thread, bb.pluginId)) {
      throw new Error(
        `Refusing to retire unverified legacy issue-draft thread ${thread.id}`
      );
    }
    if (thread.archivedAt === null) {
      await bb.sdk.threads.archive({ threadId: thread.id });
    }
    await bb.sdk.threads.stop({ threadId: thread.id });
  }

  for (const key of [...requestKeys, ...threadKeys, ...cancellationKeys]) {
    await bb.storage.kv.delete(key);
  }
}
