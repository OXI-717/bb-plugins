// @vitest-environment jsdom
import { afterEach, describe, it, expect } from "vitest";
import { fireEvent, cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
const source = {
  id: "example",
  name: "Example scheduler",
  staleAfterMs: 60000,
  checkedAt: Date.now(),
  lastSuccessAt: Date.now(),
  error: null,
};
const task = {
  id: "daily",
  key: "task_daily",
  name: "Daily report",
  sourceId: "example",
  host: "example-host",
  scope: "personal",
  owner: null,
  team: null,
  projectId: null,
  scheduler: "bb",
  executor: "script",
  schedule: "*/15 * * * * UTC",
  state: "active",
  description: "",
  history: "available",
  url: null,
  observedAt: Date.now(),
  missing: false,
  lastRun: {
    id: "run1",
    taskId: "daily",
    host: "example-host",
    status: "failed",
    startedAt: Date.now() - 1000,
    finishedAt: Date.now(),
    summary: null,
    exitCode: 1,
    evidence: "execution",
    observedAt: null,
  },
};
afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
async function mount() {
  const app = await loadPluginApp(() => import("./app"));
  return renderSlot(
    app.navPanels[0]!,
    { subPath: "" },
    {
      rpc: {
        catalog_list: () => ({ tasks: [task], sources: [source] }),
        catalog_detail: () => ({
          task,
          source,
          runs: [task.lastRun],
          total: 1,
        }),
      },
    },
  );
}
describe("automation workflows", () => {
  it("shows the failed result, keeps filters on return and provides compact history", async () => {
    const slot = await mount();
    await slot.findByText("Daily report");
    expect(slot.getByText(/Last run failed/)).toBeTruthy();
    expect(slot.getAllByText("Every 15 minutes · UTC")[0]).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Needs attention/ }));
    fireEvent.click(slot.getByRole("button", { name: "Daily report" }));
    await slot.findByText("Execution history");
    expect(slot.getByRole("columnheader", { name: "Duration" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "← Automations" }));
    expect(
      slot
        .getByRole("button", { name: /Needs attention/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    slot.lifecycle.unmount();
  });
  it("prepares a personal BB creation request without starting a thread", async () => {
    const slot = await mount();
    await slot.findByText("Daily report");
    fireEvent.click(slot.getByRole("button", { name: "Create automation" }));
    fireEvent.click(slot.getByRole("button", { name: /BB automation/ }));
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(
      "personal automation",
    );
    expect(JSON.stringify(slot.inspection.navigateCalls)).toContain(
      "automations skill",
    );
    expect(
      slot.inspection.rpcCalls.every((call) =>
        ["catalog_list", "catalog_detail"].includes(call.method),
      ),
    ).toBe(true);
    slot.lifecycle.unmount();
  });
});
