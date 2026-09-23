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
        catalog_refresh: () => ({ refreshed: ["bb-main"], deferred: ["example"] }),
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
  it("uses the scheduler refresh RPC before reloading the table", async () => {
    const slot = await mount();
    await slot.findByText("Daily report");
    fireEvent.click(slot.getByRole("button", { name: "Обновить BB" }));
    await slot.findByText("BB обновлён. Остальные источники обновляются по своему расписанию.");
    expect(slot.inspection.rpcCalls.map((call) => call.method).slice(-2)).toEqual(["catalog_refresh", "catalog_list"]);
    slot.lifecycle.unmount();
  });
  it("counts attention only within the visible source and search filters", async () => {
    sessionStorage.setItem("bb:automation-catalog:filters:v1", JSON.stringify({ query: "no-match", source: "", scope: "", host: "", state: "", project: "" }));
    const slot = await mount();
    await slot.findByText("По заданным фильтрам автоматизаций нет.");
    const attention = slot.getByRole("button", { name: /Требуют внимания/ });
    expect(attention.textContent).toContain("0");
    fireEvent.click(attention);
    expect(slot.getByText("По заданным фильтрам автоматизаций нет.")).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("shows the failed result, keeps filters on return and provides compact history", async () => {
    const slot = await mount();
    await slot.findByText("Daily report");
    expect(slot.getByText(/Последний запуск завершился ошибкой/)).toBeTruthy();
    expect(slot.getAllByText("Каждые 15 минут · UTC")[0]).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: /Требуют внимания/ }));
    fireEvent.click(slot.getByRole("button", { name: "Daily report" }));
    await slot.findByText("История запусков");
    expect(slot.getByRole("columnheader", { name: "Длительность" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "← Автоматизации" }));
    expect(
      slot
        .getByRole("button", { name: /Требуют внимания/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    slot.lifecycle.unmount();
  });
  it("prepares a personal BB creation request without starting a thread", async () => {
    const slot = await mount();
    await slot.findByText("Daily report");
    fireEvent.click(slot.getByRole("button", { name: "Создать автоматизацию" }));
    fireEvent.click(slot.getByRole("button", { name: /Автоматизация BB/ }));
    expect(
      slot.getByRole("heading", { name: "Создать личную автоматизацию · Автоматизация BB" }),
    ).toBeTruthy();
    expect(
      slot.getByRole("textbox").textContent ||
        (slot.getByRole("textbox") as HTMLTextAreaElement).value,
    ).toContain("личную автоматизацию");
    expect(
      slot.inspection.rpcCalls.every((call) =>
        ["catalog_list", "catalog_detail"].includes(call.method),
      ),
    ).toBe(true);
    slot.lifecycle.unmount();
  });
  it("keeps ownership and destination correct when switching creation routes", async () => {
    const slot = await mount();
    await slot.findByText("Daily report");
    fireEvent.click(slot.getByRole("button", { name: "Создать автоматизацию" }));
    fireEvent.click(slot.getByRole("button", { name: /Серверная автоматизация/ }));
    const first = slot.getByRole("textbox") as HTMLTextAreaElement;
    expect(first.value || first.textContent).toContain("личную автоматизацию");
    fireEvent.click(slot.getByRole("button", { name: "← Автоматизации" }));
    fireEvent.change(
      slot.getByRole("combobox", { name: "Тип автоматизации" }),
      { target: { value: "team" } },
    );
    fireEvent.click(slot.getByRole("button", { name: /Автоматизация BB/ }));
    const second = slot.getByRole("textbox") as HTMLTextAreaElement;
    expect(second.value || second.textContent).toContain("командную автоматизацию");
    expect(second.value || second.textContent).toContain("скилл automations");
    expect(second.value || second.textContent).not.toContain(
      "скилл для создания серверной автоматизации",
    );
    expect(
      slot.inspection.rpcCalls.some(
        (call) => call.method === "catalog_compose",
      ),
    ).toBe(false);
    slot.lifecycle.unmount();
  });
});
