import type { ProjectThreadItem, ProjectThreadNode } from "./project-thread-groups.js";
import { getProjectThreadItemDescendants } from "./project-thread-groups.js";
import { getCollapsedChildActivity } from "./thread-activity.js";

export interface ProjectMachineGroup {
  key: string;
  hostId: string | null;
  label: string;
  items: ProjectThreadItem[];
}

export function projectMachineGroupingEnabled(
  projectId: string,
  global: boolean,
  overrides: Readonly<Record<string, "machines" | "plain">>,
): boolean {
  const override = Object.hasOwn(overrides, projectId) ? overrides[projectId] : undefined;
  return override === undefined ? global : override === "machines";
}

export function projectMachineKey(projectId: string, hostId: string | null): string {
  return JSON.stringify([projectId, hostId]);
}

/** Partition only roots. A descendant's own host never moves it away from its parent. */
export function groupProjectRootsByMachine(
  projectId: string,
  items: readonly ProjectThreadItem[],
): ProjectMachineGroup[] {
  const groups = new Map<string | null, ProjectMachineGroup>();
  function add(node: ProjectThreadNode, item: ProjectThreadItem) {
    const hostId = node.thread.host?.id ?? null;
    let group = groups.get(hostId);
    if (!group) {
      group = {
        key: projectMachineKey(projectId, hostId), hostId,
        label: node.thread.host?.name?.trim() || (hostId === null ? "Без машины" : "Неизвестная машина"),
        items: [],
      };
      groups.set(hostId, group);
    }
    group.items.push(item);
  }
  for (const item of items) {
    if (item.kind === "thread") {
      add(item.node, item);
    } else if (item.kind === "environment") {
      // A shared worktree must not place roots from different hosts in one machine group.
      const buckets = new Map<string | null, ProjectThreadNode[]>();
      for (const node of item.group.nodes) {
        const hostId = node.thread.host?.id ?? null;
        const bucket = buckets.get(hostId) ?? [];
        bucket.push(node);
        buckets.set(hostId, bucket);
      }
      for (const nodes of buckets.values()) {
        const [first, second, ...rest] = nodes;
        if (!first) continue;
        if (!second) { add(first, { kind: "thread", node: first }); continue; }
        const descendants = getProjectThreadItemDescendants(nodes.map((node) => ({ kind: "thread", node })));
        add(first, { kind: "environment", group: {
          ...item.group, nodes: [first, second, ...rest],
          stats: { childCount: descendants.length, childActivity: getCollapsedChildActivity(descendants) },
        } });
      }
    } else {
      for (const partition of groupProjectRootsByMachine(projectId, item.group.items)) {
        const descendants = getProjectThreadItemDescendants(partition.items);
        const root = descendants[0];
        if (!root) continue;
        const existing = groups.get(partition.hostId);
        const section: ProjectThreadItem = { kind: "section", group: {
          ...item.group, items: partition.items, threadCount: descendants.length,
          activity: getCollapsedChildActivity(descendants),
        } };
        if (existing) existing.items.push(section);
        else groups.set(partition.hostId, { ...partition, items: [section] });
      }
    }
  }
  return [...groups.values()].sort((a, b) =>
    Number(a.hostId === null) - Number(b.hostId === null) ||
    a.label.localeCompare(b.label) || a.key.localeCompare(b.key),
  );
}
