// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread, makeSidebarEnvironment } from "./app/model/fixtures.js";
import { defaultPreferences, type PreferenceValues } from "./shared/preferences.js";
import { flushPreferenceWritesForTest, resetPreferencesSyncForTest, setPreferencesMirrorStorageForTest } from "./app/preferences/preferences-sync.js";
import { projectMachineKey } from "./app/model/project-machine-groups.js";

import { collectSectionThreadDndLookup, resolveSectionThreadDropDecision, useSectionThreadDnd } from "./app/dnd/useSectionThreadDnd.js";
import type { SidebarThread } from "./app/model/sidebar-thread.js";

vi.mock("./app/dnd/useSectionThreadDnd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app/dnd/useSectionThreadDnd.js")>();
  return { ...actual, useSectionThreadDnd: vi.fn(actual.useSectionThreadDnd) };
});

const app = await loadPluginApp(() => import("./app.js"));
const laptop = { id: "host_laptop", name: "Laptop" };
const server = { id: "host_server", name: "Server" };
const threads = [
  makeSidebarThread({ id: "thr_parent", projectId: "proj_alpha", title: "Parent", host: laptop }),
  makeSidebarThread({ id: "thr_child", projectId: "proj_alpha", title: "Child", host: server, parentThreadId: "thr_parent" }),
  makeSidebarThread({ id: "thr_other", projectId: "proj_alpha", title: "Other", host: server }),
  makeSidebarThread({ id: "thr_beta", projectId: "proj_beta", title: "Beta task", host: server }),
];
function render(preferences: Partial<PreferenceValues> = {}, compact = false, routedThreadId: string | null = null, inputThreads: SidebarThread[] = threads) {
  setPreferencesMirrorStorageForTest(null);
  return renderSlot(app.threadLists[0]!, {
    activeThreadId: null, activeProjectId: null, isCompactViewport: compact, onNavigate: vi.fn(), searchQuery: "",
  }, {
    pluginId: "oxi-thread-list",
    context: { projectId: routedThreadId ? "proj_alpha" : null, threadId: routedThreadId },
    sidebarThreads: { threads: inputThreads, projects: [makePluginProject({ id: "proj_alpha", name: "Alpha" }), makePluginProject({ id: "proj_beta", name: "Beta" })] },
    rpc: { listPreferences: () => ({ preferences: { ...defaultPreferences(), organizationMode: "project", ...preferences } }), setPreference: (input: unknown) => input },
  });
}
const groups = () => Array.from(document.querySelectorAll("[data-project-machine-group]"));
afterEach(() => { vi.clearAllMocks(); cleanup(); resetPreferencesSyncForTest(); setPreferencesMirrorStorageForTest(undefined); });

describe("project-machine list controls", () => {
  it("renders each row once, keeps a cross-machine child under its parent, and remembers collapse", async () => {
    const view = render();
    await screen.findByText("Parent");
    const group = groups().find((g) => g.getAttribute("data-project-machine-group") === projectMachineKey("proj_alpha", laptop.id))!;
    expect(within(group as HTMLElement).getByText("Child")).toBeTruthy();
    expect(document.querySelectorAll('[data-sidebar-thread-id="thr_child"]')).toHaveLength(1);
    fireEvent.click(within(group as HTMLElement).getByRole("button", { name: "Свернуть машину Laptop" }));
    expect(screen.queryByText("Child")).toBeNull();
    expect(screen.getByText("Other")).toBeTruthy();
    await flushPreferenceWritesForTest();
    await waitFor(() => expect(view.rpcCalls).toContainEqual({ method: "setPreference", input: expect.objectContaining({
      key: "collapsedProjectMachines", value: [projectMachineKey("proj_alpha", laptop.id)],
    }) }));
    fireEvent.click(screen.getByRole("button", { name: "Развернуть машину Laptop" }));
    expect(screen.getByText("Child")).toBeTruthy();
  });
  it("applies independent project overrides to the global switch", async () => {
    render({ projectMachineGrouping: false, projectMachineOverrides: { proj_alpha: "machines" } });
    await screen.findByText("Parent");
    expect(groups()).toHaveLength(2);
    expect(groups().every((group) => group.getAttribute("data-project-machine-group")?.includes("proj_alpha"))).toBe(true);
    expect(screen.getByText("Beta task")).toBeTruthy();
  });
  it("reveals the root's machine group when navigating to its child on another host", async () => {
    render({ collapsedThreads: ["thr_parent"], collapsedProjectMachines: [
      projectMachineKey("proj_alpha", laptop.id), projectMachineKey("proj_alpha", server.id),
    ] }, false, "thr_child");
    await screen.findByText("Child");
    expect(screen.getByRole("button", { name: "Свернуть машину Laptop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Развернуть машину Server" })).toBeTruthy();
    expect(screen.queryByText("Other")).toBeNull();
  });
  it("reveals a cross-project child's ancestor machine without opening the child's own machine", async () => {
    render({ collapsedThreads: ["thr_parent"], collapsedProjectMachines: [
      projectMachineKey("proj_alpha", laptop.id), projectMachineKey("proj_alpha", server.id),
    ] }, false, "thr_child", threads.map((thread) => thread.id === "thr_child"
      ? { ...thread, projectId: "proj_beta" } : thread));
    await screen.findByText("Child");
    expect(screen.getByRole("button", { name: "Свернуть машину Laptop" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Развернуть машину Server" })).toBeTruthy();
    expect(screen.queryByText("Other")).toBeNull();
  });
  it.each([true, false])("uses the rendered worktree partitions for drag-to-pin with grouping=%s", async (grouping) => {
    const environment = makeSidebarEnvironment({ id: "env_shared", isWorktree: true });
    const mixed = [
      ...["a1", "a2"].map((id) => makeSidebarThread({ id, title: id, projectId: "proj_alpha", host: laptop, environment })),
      ...["b1", "b2"].map((id) => makeSidebarThread({ id, title: id, projectId: "proj_alpha", host: server, environment })),
      makeSidebarThread({ id: "remote-child", title: "Remote child", projectId: "proj_beta", host: server, environment, parentThreadId: "a1" }),
    ];
    render({ projectMachineGrouping: grouping }, false, null, mixed);
    await waitFor(() => expect(vi.mocked(useSectionThreadDnd).mock.lastCall?.[0].rootItems.length).toBeGreaterThan(0));
    const args = vi.mocked(useSectionThreadDnd).mock.lastCall![0];
    const lookup = collectSectionThreadDndLookup(args.rootItems, "threads", [], [], { groups: true });
    const decisions = [...lookup.itemKindById].filter(([, kind]) => kind === "environment")
      .map(([id]) => resolveSectionThreadDropDecision(lookup, id, "pinned"));
    expect(decisions.every((decision) => decision?.kind === "pin")).toBe(true);
    expect(decisions.map((decision) => decision && "pinThreadIds" in decision ? [...decision.pinThreadIds].sort() : [])
      .sort((a, b) => a.join().localeCompare(b.join()))).toEqual(grouping ? [["a1", "a2"], ["b1", "b2"]] : [["a1", "a2", "b1", "b2"]]);
    expect(lookup.nestParentIdByItemId.get("remote-child")).toBe("a1");
  });
  it("changes one project's override through its real menu and restores inheritance", async () => {
    render();
    await screen.findByText("Parent");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Alpha actions" }), { button: 0, ctrlKey: false });
    const plain = await screen.findByRole("menuitemradio", { name: "Без групп машин" });
    fireEvent.click(plain);
    await waitFor(() => expect(groups()).toHaveLength(1));
    expect(screen.getByText("Child")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Как в общих настройках" }));
    await waitFor(() => expect(groups()).toHaveLength(3));
  });
  it("toggles the global setting in the compact Organize menu without altering hierarchy", async () => {
    render({}, true);
    await screen.findByText("Parent");
    fireEvent.click(screen.getByRole("button", { name: "Alpha actions" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Organize" }));
    const toggle = await screen.findByRole("menuitemcheckbox", { name: "Машины внутри проектов" });
    fireEvent.click(toggle);
    await waitFor(() => expect(groups()).toHaveLength(0));
    expect(screen.getByText("Child")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(groups()).toHaveLength(3));
  });
  it("does not add project-machine groups in chronological or top-level machine modes", async () => {
    const view = render({ organizationMode: "chronological" });
    await screen.findByText("Parent");
    expect(groups()).toHaveLength(0);
    view.unmount();
    resetPreferencesSyncForTest();
    render({ organizationMode: "machine" });
    await screen.findByText("Parent");
    expect(groups()).toHaveLength(0);
  });
});
