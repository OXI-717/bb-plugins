import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  countThreadExclusions,
  affectedSnapshots,
  planRoot,
  planPrune,
  planSweep,
  type Config,
  type Plan,
  type Snapshot,
} from "./policy.js";

type Row = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
export interface Report extends Plan {
  dryRun: boolean;
  scanned: number;
  archivedRoots: number;
  detached: number;
  candidates: { id: string; title: string }[];
}
async function mapBatches<T>(items: T[], fn: (item: T) => Promise<void>) {
  for (let i = 0; i < items.length; i += 8)
    await Promise.all(items.slice(i, i + 8).map(fn));
}
export async function collect(
  bb: BbPluginApi,
  config: Config,
  now: number,
  signal?: AbortSignal,
): Promise<Snapshot[]> {
  const rows = new Map<string, Row>();
  // Archived intermediaries still carry cascade edges to live descendants.
  for (const archived of [false, true])
    for (let offset = 0; ; offset += 100) {
      signal?.throwIfAborted();
      const page = await bb.sdk.threads.list({
        archived,
        includeHidden: true,
        limit: 100,
        offset,
        signal,
      });
      for (const t of page) rows.set(t.id, t);
      if (page.length < 100) break;
      if (offset >= 100_000)
        throw new Error(
          "Thread inventory exceeds safety limit; no actions performed",
        );
    }
  const snapshots: Snapshot[] = [];
  const statuses = new Map<string, Promise<Snapshot["workspace"]>>();
  await mapBatches([...rows.values()], async (t) => {
    signal?.throwIfAborted();
    let at = t.latestAttentionAt;
    let workspace: Snapshot["workspace"] = "clean";
    if (t.archivedAt === null) {
      // Child completions may not advance latestAttentionAt. Read actual turn
      // events as well; reads and metadata edits are excluded from activity.
      try {
        const events = await bb.sdk.threads.events.list({
          threadId: t.id,
          order: "desc",
          limit: "1",
          types: ["turn/started", "turn/completed", "turn/input/accepted"],
          signal,
        });
        if (events.length) at = Math.max(at, events[0].createdAt);
      } catch {
        at = NaN;
      } // Unknown activity protects the tree.
      if (t.environmentId) {
        let status = statuses.get(t.environmentId);
        if (!status) {
          status = bb.sdk.environments
            .status({ environmentId: t.environmentId, signal })
            .then((result) => {
              if (result.outcome === "available")
                return result.workspace.workingTree.hasUncommittedChanges
                  ? ("dirty" as const)
                  : ("clean" as const);
              return result.outcome === "not_applicable" &&
                t.environmentIsWorktree === false
                ? ("clean" as const)
                : ("unknown" as const);
            })
            .catch(() => "unknown" as const);
          statuses.set(t.environmentId, status);
        }
        workspace = await status;
      } else if (t.environmentIsWorktree) workspace = "unknown";
    }
    snapshots.push({
      id: t.id,
      title: t.title,
      titleFallback: t.titleFallback,
      parentThreadId: t.parentThreadId,
      lifecycleOwnerThreadId: t.lifecycleOwnerThreadId,
      sourceThreadId: t.sourceThreadId,
      visibility: t.visibility,
      latestAttentionAt: at,
      status: t.status,
      pinnedAt: t.pinnedAt,
      workspace,
      archived: t.archivedAt !== null,
      busy:
        t.queuedWork !== "none" ||
        t.hasPendingInteraction ||
        Object.values(t.activity).some((count) => count > 0),
    });
  });
  // Completion order must not affect plans or revalidation fingerprints.
  return snapshots.sort((a, b) => a.id.localeCompare(b.id));
}
export async function runOperation(
  bb: BbPluginApi,
  config: Config & { dryRun: boolean },
  options: {
    dryRun?: boolean;
    targetId?: string;
    signal?: AbortSignal;
    now?: number;
  } = {},
): Promise<Report> {
  const now = options.now ?? Date.now();
  const dryRun = config.dryRun || options.dryRun === true;
  const build = (rows: Snapshot[]) =>
    options.targetId
      ? planPrune(rows, config, now, options.targetId)
      : planSweep(rows, config, now);
  const snapshots = await collect(bb, config, now, options.signal);
  const plan = build(snapshots);
  const report: Report = {
    ...plan,
    dryRun,
    scanned: snapshots.filter((t) => !t.archived).length,
    archivedRoots: 0,
    detached: 0,
    candidates: plan.actions.map((a) => ({
      id: a.rootId,
      title: (() => {
        const t = snapshots.find((t) => t.id === a.rootId)!;
        return t.title ?? t.titleFallback ?? "untitled";
      })(),
    })),
  };
  if (dryRun || (!plan.actions.length && !plan.detachIds.length)) return report;
  // Public APIs offer no atomic conditional archive. Re-read before changing
  // anything, and again after detaching, to narrow the unavoidable race.
  const current = await collect(bb, config, now, options.signal);
  if (
    JSON.stringify(affectedSnapshots(current, plan)) !==
    JSON.stringify(affectedSnapshots(snapshots, plan))
  )
    throw new Error("Thread/workspace inventory changed; retry preview");
  for (const id of plan.detachIds) {
    options.signal?.throwIfAborted();
    await bb.sdk.threads.update({ threadId: id, parentThreadId: null });
    report.detached++;
  }
  for (const action of plan.actions) {
    options.signal?.throwIfAborted();
    // Compare to a fresh plan before each action. Any pin, activity, dirty
    // checkout or newly attached descendant aborts the remaining operation.
    const valid = planRoot(
      await collect(bb, config, now, options.signal),
      config,
      now,
      action.rootId,
      options.targetId,
      plan.pruneAncestorIds,
    );
    if (
      typeof valid === "string" ||
      JSON.stringify(valid) !== JSON.stringify(action)
    )
      throw new Error("Archive plan changed; retry preview");
    for (const id of action.detachIds) {
      options.signal?.throwIfAborted();
      await bb.sdk.threads.update({ threadId: id, parentThreadId: null });
      report.detached++;
    }
    const safe = planRoot(
      await collect(bb, config, now, options.signal),
      config,
      now,
      action.rootId,
      options.targetId,
      plan.pruneAncestorIds,
    );
    if (
      typeof safe === "string" ||
      safe.detachIds.length ||
      JSON.stringify(safe.archiveIds) !== JSON.stringify(action.archiveIds)
    ) {
      throw new Error("Tree changed after detach; nothing further archived");
    }
    options.signal?.throwIfAborted();
    await bb.sdk.threads.archive({ threadId: action.rootId });
    report.archivedRoots++;
  }
  return report;
}
export function parseDays(raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 36500)
    throw new Error("inactivityDays must be between 1 and 36500");
  return value;
}
export function parseKeep(raw: string): string[] {
  if (raw.length > 262144) throw new Error("keepThreadIds exceeds 256 KiB");
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.length > 10000 ||
    !value.every(
      (id) =>
        typeof id === "string" &&
        id.length <= 128 &&
        /^thr_[a-zA-Z0-9_-]+$/.test(id),
    )
  ) {
    throw new Error("keepThreadIds must be a JSON array of thread IDs");
  }
  return [...new Set(value)];
}

/** Bound CLI and persisted diagnostics independently of inventory size. */
export function summarize(report: Report) {
  const limit = 100;
  const { pruneAncestorIds: _executionContext, ...publicReport } = report;
  return {
    ...publicReport,
    candidateCount: report.actions.length,
    blockedCount: report.blocked.length,
    detachCount:
      report.detachIds.length +
      report.actions.reduce((n, a) => n + a.detachIds.length, 0),
    affectedThreadCount: new Set(report.actions.flatMap((a) => a.archiveIds))
      .size,
    truncated:
      report.actions.length > limit ||
      report.blocked.length > limit ||
      report.detachIds.length > limit ||
      report.actions.some(
        (a) => a.archiveIds.length > limit || a.detachIds.length > limit,
      ),
    actions: report.actions.slice(0, limit).map((a) => ({
      ...a,
      archiveIds: a.archiveIds.slice(0, limit),
      detachIds: a.detachIds.slice(0, limit),
    })),
    detachIds: report.detachIds.slice(0, limit),
    blocked: report.blocked.slice(0, limit),
    candidates: report.candidates
      .slice(0, limit)
      .map((t) => ({ ...t, title: t.title.slice(0, 200) })),
  };
}

/** Read-only live counts need only list fields, no workspace/event probes. */
export async function exclusionStatus(
  bb: BbPluginApi,
  config: Pick<Config, "keepThreadIds">,
  signal?: AbortSignal,
) {
  const rows = new Map<
    string,
    {
      id: string;
      title: string | null;
      titleFallback?: string | null;
      pinnedAt: number | null;
    }
  >();
  for (let offset = 0; ; offset += 100) {
    signal?.throwIfAborted();
    const page = await bb.sdk.threads.list({
      archived: false,
      includeHidden: true,
      limit: 100,
      offset,
      signal,
    });
    for (const t of page)
      if (t.archivedAt === null && t.deletedAt === null) rows.set(t.id, t);
    if (page.length < 100) break;
    if (offset >= 100_000)
      throw new Error("Thread inventory exceeds safety limit");
  }
  return {
    scanned: rows.size,
    reasons: countThreadExclusions([...rows.values()], config),
    overlapping: true,
  };
}
