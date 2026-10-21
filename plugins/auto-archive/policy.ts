// Tree-aware selection for the MIT Auto Archive fork (upstream: Shane Logsdon).
export const DAY = 86_400_000;
export interface Snapshot {
  id: string;
  title: string;
  parentThreadId: string | null;
  lifecycleOwnerThreadId: string | null;
  sourceThreadId: string | null;
  visibility: "visible" | "hidden";
  latestAttentionAt: number;
  status: string;
  pinnedAt: number | null;
  workspace: "clean" | "dirty" | "unknown";
  busy?: boolean;
  archived?: boolean;
}
export interface Config {
  inactivityDays: number;
  sinceInstallAt: number;
  keepThreadIds: string[];
  detachActiveDescendants: boolean;
}
export interface Action {
  rootId: string;
  detachIds: string[];
  archiveIds: string[];
}
export interface Plan {
  actions: Action[];
  detachIds: string[];
  blocked: string[];
  backlogRoots: number;
}
const empty = (): Plan => ({
  actions: [],
  detachIds: [],
  blocked: [],
  backlogRoots: 0,
});

// Hidden source forks also follow source archive in BB; the source relation is
// immutable too. Ordinary visible source references do not imply ownership.
export function owners(t: Snapshot, cuts = new Set<string>()): string[] {
  return [
    ...new Set(
      [
        cuts.has(t.id) ? null : t.parentThreadId,
        t.lifecycleOwnerThreadId,
        t.visibility === "hidden" ? t.sourceThreadId : null,
      ].filter((id): id is string => id !== null),
    ),
  ];
}
function closure(
  root: string,
  threads: readonly Snapshot[],
  cuts = new Set<string>(),
): Snapshot[] {
  const selected = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const t of threads) {
      if (
        !selected.has(t.id) &&
        owners(t, cuts).some((id) => selected.has(id))
      ) {
        selected.add(t.id);
        changed = true;
      }
    }
  }
  return threads.filter((t) => selected.has(t.id));
}
const protectedThread = (t: Snapshot, c: Config) =>
  t.pinnedAt !== null ||
  t.title.startsWith("📌") ||
  c.keepThreadIds.includes(t.id) ||
  t.visibility === "hidden" ||
  t.workspace !== "clean";
const active = (t: Snapshot, cutoff: number) =>
  !Number.isFinite(t.latestAttentionAt) ||
  t.latestAttentionAt > cutoff ||
  !["idle", "error"].includes(t.status) ||
  t.busy === true;

function actionFor(
  root: Snapshot,
  threads: readonly Snapshot[],
  c: Config,
  now: number,
  initialCuts = new Set<string>(),
  preserve = new Set<string>(),
): Action | string {
  const cutoff = now - c.inactivityDays * DAY;
  const cuts = new Set(initialCuts);
  const tree = closure(root.id, threads, cuts);
  const exception = tree.find((t) => !t.archived && protectedThread(t, c));
  if (exception)
    return `${root.id}: protected ${exception.id} (pin, keep, hidden or workspace)`;
  if (active(root, cutoff)) return `${root.id}: root is active`;
  const retained = new Set(preserve);
  for (const t of tree)
    if (!t.archived && active(t, cutoff)) {
      for (const child of closure(t.id, threads)) retained.add(child.id);
    }
  const needsCut = tree.filter((t) => retained.has(t.id));
  if (needsCut.length && !c.detachActiveDescendants)
    return `${root.id}: active descendant`;
  for (const t of needsCut) if (t.parentThreadId) cuts.add(t.id);
  const remaining = closure(root.id, threads, cuts);
  const immutable = remaining.find((t) => retained.has(t.id));
  if (immutable)
    return `${root.id}: cannot detach lifecycle owner or hidden source for ${immutable.id}`;
  const live = remaining.filter((t) => !t.archived);
  if (Math.max(...live.map((t) => t.latestAttentionAt)) < c.sinceInstallAt)
    return `${root.id}: pre-install backlog`;
  return {
    rootId: root.id,
    detachIds: needsCut
      .filter(
        (t) =>
          t.parentThreadId &&
          !initialCuts.has(t.id) &&
          remaining.some((parent) => parent.id === t.parentThreadId),
      )
      .map((t) => t.id),
    archiveIds: live.map((t) => t.id),
  };
}

export function planSweep(
  threads: readonly Snapshot[],
  config: Config,
  now: number,
): Plan {
  const p = empty();
  for (const root of threads.filter(
    (t) => !t.archived && owners(t).length === 0,
  )) {
    const tree = closure(root.id, threads).filter((t) => !t.archived);
    const latest = Math.max(...tree.map((t) => t.latestAttentionAt));
    if (
      latest < config.sinceInstallAt &&
      latest <= now - config.inactivityDays * DAY &&
      tree.every((t) => !active(t, now - config.inactivityDays * DAY))
    )
      p.backlogRoots++;
    const action = actionFor(root, threads, config, now);
    if (typeof action === "string") p.blocked.push(action);
    else p.actions.push(action);
  }
  return p;
}

export function planPrune(
  threads: readonly Snapshot[],
  config: Config,
  now: number,
  targetId: string,
): Plan {
  const p = empty();
  const target = threads.find((t) => t.id === targetId && !t.archived);
  if (!target) {
    p.blocked.push("target must be a live thread");
    return p;
  }
  if (
    target.lifecycleOwnerThreadId ||
    (target.visibility === "hidden" && target.sourceThreadId)
  ) {
    p.blocked.push(
      `${targetId}: lifecycle owner / hidden source is immutable; cannot fully detach`,
    );
    return p;
  }
  // Explicit target is allowed to stay active; exceptions still prohibit edits.
  if (protectedThread(target, config)) {
    p.blocked.push(`${targetId}: protected target`);
    return p;
  }
  const byId = new Map(threads.map((t) => [t.id, t]));
  const ancestors = new Set<string>();
  const pending = owners(target);
  while (pending.length) {
    const id = pending.pop()!;
    if (id === targetId) {
      p.blocked.push("cycle in ancestry");
      return p;
    }
    if (ancestors.has(id)) continue;
    ancestors.add(id);
    const t = byId.get(id);
    if (!t) {
      p.blocked.push(`missing ancestor ${id}`);
      return p;
    }
    pending.push(...owners(t));
  }
  if (target.parentThreadId) p.detachIds.push(targetId);
  const cuts = new Set(p.detachIds);
  const preserve = new Set(closure(targetId, threads).map((t) => t.id));
  // Only ancestors can be entry points. Siblings are included solely through a
  // safe ancestor's cascade. Young/protected ancestors stay and may have old
  // children independently removed by this explicit command.
  const handled = new Set<string>();
  const sorted = threads
    .filter((t) => ancestors.has(t.id) && !t.archived)
    .sort(
      (a, b) => closure(b.id, threads).length - closure(a.id, threads).length,
    );
  for (const root of sorted) {
    if (handled.has(root.id)) continue;
    const action = actionFor(
      root,
      threads,
      { ...config, sinceInstallAt: 0, detachActiveDescendants: true },
      now,
      cuts,
      preserve,
    );
    if (typeof action === "string") p.blocked.push(action);
    else {
      p.actions.push(action);
      action.archiveIds.forEach((id) => handled.add(id));
    }
  }
  return p;
}

export function planRoot(
  threads: readonly Snapshot[],
  config: Config,
  now: number,
  rootId: string,
  targetId?: string,
): Action | string {
  const root = threads.find((t) => t.id === rootId && !t.archived);
  if (!root) return "root is no longer live";
  return actionFor(
    root,
    threads,
    targetId
      ? { ...config, sinceInstallAt: 0, detachActiveDescendants: true }
      : config,
    now,
    new Set(),
    targetId ? new Set(closure(targetId, threads).map((t) => t.id)) : new Set(),
  );
}

/** Include new descendants during revalidation, but ignore unrelated trees. */
export function affectedSnapshots(
  threads: readonly Snapshot[],
  plan: Plan,
): Snapshot[] {
  const ids = new Set<string>();
  for (const root of [
    ...plan.actions.map((a) => a.rootId),
    ...plan.detachIds,
  ]) {
    for (const t of closure(root, threads)) ids.add(t.id);
  }
  return threads.filter((t) => ids.has(t.id));
}
