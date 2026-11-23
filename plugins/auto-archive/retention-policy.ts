// Pure retention planning for archived thread files and automated thread export+delete.
import { DAY, effectiveRetentionDays, threadExclusions } from "./policy.js";

export const DEFAULT_AUTOMATED_ORIGIN_PLUGINS = [
  "workflows",
  "automations",
  "automation-catalog",
  "oxi-autopilot",
  "aim-growth",
] as const;

export interface RetentionConfig {
  keepThreadIds: string[];
  unarchiveGraceMultiplier: number;
  enableArchivedFileCleanup: boolean;
  clearArchivedFilesAfterDays: number;
  enableAutomatedExportDelete: boolean;
  exportDeleteAfterDays: number;
  exportDir: string;
  automatedOriginPluginIds: string[];
  retentionMaxPerRun: number;
}

export interface RetentionSnapshot {
  id: string;
  title: string | null;
  titleFallback?: string | null;
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
  busy: boolean;
  permanent: boolean;
  unarchiveCount: number;
  lastUnarchivedAt: number | null;
  environmentId: string | null;
  environmentHostId: string | null;
}

export type AutomatedDeletionReason =
  | "origin-plugin"
  | "hidden"
  | "child-of-archived-or-missing-parent";

export interface FileCleanupCandidate {
  id: string;
  title: string;
  archivedAt: number;
  unarchiveCount: number;
  effectiveDays: number;
  environmentId: string | null;
  environmentHostId: string | null;
}

export interface ExportDeleteCandidate {
  id: string;
  title: string;
  reason: AutomatedDeletionReason;
  archivedAt: number;
  unarchiveCount: number;
  effectiveDays: number;
  originPluginId: string | null;
  parentThreadId: string | null;
  visibility: "visible" | "hidden";
}

function ownerIds(t: RetentionSnapshot): string[] {
  return [
    ...new Set(
      [
        t.parentThreadId,
        t.lifecycleOwnerThreadId,
        t.visibility === "hidden" ? t.sourceThreadId : null,
      ].filter((id): id is string => id !== null),
    ),
  ];
}

function isLive(t: RetentionSnapshot | undefined): boolean {
  return t !== undefined && t.archivedAt === null && t.deletedAt === null;
}

/** Returns a protection/ineligibility reason, or null if the archived thread can be acted on. */
export function retentionProtectionReason(
  t: Pick<
    RetentionSnapshot,
    | "id"
    | "title"
    | "titleFallback"
    | "archivedAt"
    | "deletedAt"
    | "pinnedAt"
    | "status"
    | "busy"
    | "permanent"
  >,
  config: Pick<RetentionConfig, "keepThreadIds">,
): string | null {
  if (t.deletedAt !== null) return "deleted";
  if (t.archivedAt === null) return "live";
  if (!Number.isFinite(t.archivedAt) || t.archivedAt <= 0)
    return "invalid-archived-at";
  const exclusions = threadExclusions(t, config);
  if (exclusions.permanent) return "permanent";
  if (exclusions.pinned) return "pinned";
  if (exclusions.pinPrefix) return "pin-prefix";
  if (exclusions.keepThreadIds) return "keep-thread-id";
  if (!["idle", "error"].includes(t.status) || t.busy) return "active-or-busy";
  return null;
}

/**
 * Only clearly automated or archived child threads may be exported and deleted.
 * Manually created visible root threads (originPluginId === null, or user-facing
 * plugins such as handoff / oxi-projects) are NEVER eligible for deletion.
 */
export function classifyAutomatedDeletion(
  t: RetentionSnapshot,
  byId: ReadonlyMap<string, RetentionSnapshot>,
  config: Pick<RetentionConfig, "automatedOriginPluginIds">,
): AutomatedDeletionReason | null {
  // Never delete a thread while any direct owner/parent/source is still live.
  for (const ownerId of ownerIds(t)) {
    if (isLive(byId.get(ownerId))) return null;
  }
  if (
    t.originPluginId !== null &&
    config.automatedOriginPluginIds.includes(t.originPluginId)
  ) {
    return "origin-plugin";
  }
  if (t.visibility === "hidden") {
    return "hidden";
  }
  if (t.parentThreadId !== null) {
    return "child-of-archived-or-missing-parent";
  }
  return null;
}

export function planArchivedFileCleanup(
  threads: readonly RetentionSnapshot[],
  config: Pick<
    RetentionConfig,
    | "keepThreadIds"
    | "unarchiveGraceMultiplier"
    | "clearArchivedFilesAfterDays"
  >,
  now: number,
): {
  candidates: FileCleanupCandidate[];
  skipped: Record<string, number>;
} {
  const candidates: FileCleanupCandidate[] = [];
  const skipped: Record<string, number> = {};
  const bump = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  for (const t of threads) {
    if (t.archivedAt === null || t.deletedAt !== null) continue;
    const reason = retentionProtectionReason(t, config);
    if (reason) {
      bump(reason);
      continue;
    }
    const effectiveDays = effectiveRetentionDays(
      config.clearArchivedFilesAfterDays,
      t.unarchiveCount,
      config.unarchiveGraceMultiplier,
    );
    if (now - t.archivedAt! < effectiveDays * DAY) {
      bump("within-retention-window");
      continue;
    }
    candidates.push({
      id: t.id,
      title: t.title ?? t.titleFallback ?? "untitled",
      archivedAt: t.archivedAt!,
      unarchiveCount: t.unarchiveCount,
      effectiveDays,
      environmentId: t.environmentId,
      environmentHostId: t.environmentHostId,
    });
  }
  candidates.sort((a, b) => a.archivedAt - b.archivedAt || a.id.localeCompare(b.id));
  return { candidates, skipped };
}

export function planAutomatedExportDelete(
  threads: readonly RetentionSnapshot[],
  config: Pick<
    RetentionConfig,
    | "keepThreadIds"
    | "unarchiveGraceMultiplier"
    | "exportDeleteAfterDays"
    | "automatedOriginPluginIds"
  >,
  now: number,
): {
  candidates: ExportDeleteCandidate[];
  skipped: Record<string, number>;
} {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const eligible = new Map<string, ExportDeleteCandidate>();
  const skipped: Record<string, number> = {};
  const bump = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  for (const t of threads) {
    if (t.archivedAt === null || t.deletedAt !== null) continue;
    const protection = retentionProtectionReason(t, config);
    if (protection) {
      bump(protection);
      continue;
    }
    const kind = classifyAutomatedDeletion(t, byId, config);
    if (!kind) {
      bump("manual-or-live-owner");
      continue;
    }
    const effectiveDays = effectiveRetentionDays(
      config.exportDeleteAfterDays,
      t.unarchiveCount,
      config.unarchiveGraceMultiplier,
    );
    if (now - t.archivedAt! < effectiveDays * DAY) {
      bump("within-retention-window");
      continue;
    }
    eligible.set(t.id, {
      id: t.id,
      title: t.title ?? t.titleFallback ?? "untitled",
      reason: kind,
      archivedAt: t.archivedAt!,
      unarchiveCount: t.unarchiveCount,
      effectiveDays,
      originPluginId: t.originPluginId,
      parentThreadId: t.parentThreadId,
      visibility: t.visibility,
    });
  }

  // Fixed-point graph barrier: never delete a thread that still has ANY
  // non-deleted child/dependent outside the eligible set.
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of threads) {
      if (t.deletedAt !== null) continue;
      if (eligible.has(t.id)) continue;
      for (const ownerId of ownerIds(t)) {
        if (eligible.delete(ownerId)) {
          bump("protected-or-retained-descendant");
          changed = true;
        }
      }
    }
  }

  // Bottom-up topological sort (leaves first, owners after all eligible dependents).
  // Any cycle among eligible nodes never reaches childCount === 0 and is safely excluded.
  const remainingChildren = new Map<string, number>();
  const eligibleOwners = new Map<string, string[]>();
  for (const id of eligible.keys()) remainingChildren.set(id, 0);
  for (const id of eligible.keys()) {
    const t = byId.get(id)!;
    const ownersInSet = ownerIds(t).filter((ownerId) => eligible.has(ownerId));
    eligibleOwners.set(id, ownersInSet);
    for (const ownerId of ownersInSet) {
      remainingChildren.set(ownerId, (remainingChildren.get(ownerId) ?? 0) + 1);
    }
  }

  const ready: ExportDeleteCandidate[] = [];
  for (const [id, count] of remainingChildren) {
    if (count === 0) ready.push(eligible.get(id)!);
  }
  const sortReady = () =>
    ready.sort(
      (a, b) => a.archivedAt - b.archivedAt || a.id.localeCompare(b.id),
    );
  sortReady();

  const ordered: ExportDeleteCandidate[] = [];
  while (ready.length > 0) {
    const current = ready.shift()!;
    ordered.push(current);
    for (const ownerId of eligibleOwners.get(current.id) ?? []) {
      const next = (remainingChildren.get(ownerId) ?? 0) - 1;
      remainingChildren.set(ownerId, next);
      if (next === 0) {
        ready.push(eligible.get(ownerId)!);
        sortReady();
      }
    }
  }

  const excludedByCycle = eligible.size - ordered.length;
  for (let i = 0; i < excludedByCycle; i++) bump("cycle-in-graph");

  return { candidates: ordered, skipped };
}
