import { describe, expect, it } from "vitest";
import { makeSidebarThread, makeSidebarEnvironment } from "./fixtures.js";
import { buildProjectThreadGroups, getProjectThreadItemDescendants } from "./project-thread-groups.js";
import { groupProjectRootsByMachine, projectMachineGroupingEnabled, projectMachineKey } from "./project-machine-groups.js";

const laptop = { id: "host_laptop", name: "Laptop" };
const server = { id: "host_server", name: "Server" };
const root = makeSidebarThread({ id: "root", host: laptop });
const child = makeSidebarThread({ id: "child", parentThreadId: "root", host: server });
const other = makeSidebarThread({ id: "other", host: server });

describe("machines inside projects", () => {
  it("keeps a child on another machine under its original parent", () => {
    const groups = groupProjectRootsByMachine("p", buildProjectThreadGroups([root, child, other]));
    expect(groups.map((group) => [group.hostId, getProjectThreadItemDescendants(group.items).map((thread) => thread.id)])).toEqual([
      [laptop.id, ["root", "child"]], [server.id, ["other"]],
    ]);
    expect(groups[0]!.items[0]).toMatchObject({ kind: "thread", node: { thread: root, children: [{ kind: "thread", node: { thread: child } }] } });
    expect(child.host).toEqual(server);
  });
  it("splits a worktree group by root host while preserving its descendants", () => {
    const environment = makeSidebarEnvironment({ id: "env_shared", isWorktree: true });
    const threads = [root, child, other, makeSidebarThread({ id: "second", host: laptop })]
      .map((thread) => ({ ...thread, environment }));
    const groups = groupProjectRootsByMachine("p", buildProjectThreadGroups(threads));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.items[0]!.kind).toBe("environment");
    expect(groups[1]!.items[0]!.kind).toBe("thread");
    expect(getProjectThreadItemDescendants(groups[0]!.items).map((thread) => thread.id).sort()).toEqual(["child", "root", "second"]);
    expect(getProjectThreadItemDescendants(groups[1]!.items).map((thread) => thread.id)).toEqual(["other"]);
  });
  it.each([true, false])("inherits global=%s unless this project overrides it", (global) => {
    expect(projectMachineGroupingEnabled("p", global, {})).toBe(global);
    expect(projectMachineGroupingEnabled("p", global, { p: "machines" })).toBe(true);
    expect(projectMachineGroupingEnabled("p", global, { p: "plain" })).toBe(false);
    expect(projectMachineGroupingEnabled("other", global, { p: "plain" })).toBe(global);
    expect(projectMachineGroupingEnabled("toString", global, {})).toBe(global);
  });
  it("keeps unknown machines separate by identity and namespaces collapsed groups", () => {
    const groups = groupProjectRootsByMachine("p", buildProjectThreadGroups([
      makeSidebarThread({ id: "a", host: { id: "host_a", name: "" } }),
      makeSidebarThread({ id: "b", host: { id: "host_b", name: "" } }),
      makeSidebarThread({ id: "c", host: null }),
    ]));
    expect(groups).toHaveLength(3);
    expect(new Set(groups.map((group) => group.key)).size).toBe(3);
    expect(projectMachineKey("p", "a:b")).not.toBe(projectMachineKey("p:a", "b"));
    expect(projectMachineKey("p", null)).not.toBe(projectMachineKey("p", "null"));
    expect(projectMachineKey("other", laptop.id)).not.toBe(projectMachineKey("p", laptop.id));
  });
  it("preserves every visible node once for 300 deterministic graphs, including cycles and missing parents", () => {
    let seed = 20261113;
    const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    for (let run = 0; run < 300; run++) {
      const threads = Array.from({ length: 25 }, (_, index) => makeSidebarThread({
        id: `t${index}`, parentThreadId: random(4) === 0 ? null : `t${random(30)}`,
        host: [laptop, server, null][random(3)]!, isHidden: random(8) === 0,
        environment: random(2) ? makeSidebarEnvironment({ id: `e${random(3)}`, isWorktree: true }) : null,
      }));
      const tree = buildProjectThreadGroups(threads);
      const grouped = groupProjectRootsByMachine("p", tree);
      const ids = grouped.flatMap((group) => getProjectThreadItemDescendants(group.items).map((thread) => thread.id));
      expect(ids.sort()).toEqual(getProjectThreadItemDescendants(tree).map((thread) => thread.id).sort());
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
