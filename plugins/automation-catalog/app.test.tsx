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
        catalog_compose_context: () => ({ parentThreadId: "thread_catalog", parentTitle: "Automation discussions", projectId: "project_catalog" }),
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
  it("shows models and allows finding tasks without a project", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const agent = { provider: "example", model: "example-model", reasoning: null, serviceTier: null, modelSource: "automation" };
    const tasks = [{ ...task, agent }, { ...task, key: "linked", name: "Linked", projectId: "project-example", projectName: "Example" }];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { catalog_list: () => ({ tasks, sources: [source] }) } });
    await slot.findByText("Модель: example-model · example");
    fireEvent.change(slot.getByRole("combobox", { name: "Проект" }), { target: { value: "__catalog_unlinked_project__" } });
    expect(slot.getByRole("button", { name: "Daily report" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Linked" })).toBeNull();
    slot.lifecycle.unmount();
  });
  it("shows projects separately and removes the old executor host filter", async () => {
    sessionStorage.setItem("bb:automation-catalog:filters:v2", JSON.stringify({ query: "", source: "", scope: "", host: "BB-managed agent", state: "current", project: "" }));
    const app = await loadPluginApp(() => import("./app"));
    const tasks = [
      { ...task, host: "BB-managed agent", projectId: "alpha", projectName: "Alpha" },
      { ...task, id: "other", key: "other", name: "Other report", host: "BB-managed agent", projectId: "beta", projectName: "Beta" },
    ];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { catalog_list: () => ({ tasks, sources: [source] }) } });
    await slot.findByRole("button", { name: "Daily report" });
    expect(slot.getByRole("button", { name: "Other report" })).toBeTruthy();
    expect(slot.getByText(/Проект: Alpha/)).toBeTruthy();
    expect(slot.getByText(/Проект: Beta/)).toBeTruthy();
    expect(slot.queryByRole("option", { name: "BB-managed agent" })).toBeNull();
    fireEvent.change(slot.getByRole("combobox", { name: "Проект" }), { target: { value: "alpha" } });
    expect(slot.queryByRole("button", { name: "Other report" })).toBeNull();
    expect(slot.getByRole("button", { name: "Daily report" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("offers a way out of an empty section without clearing other filters", async () => {
    sessionStorage.setItem("bb:automation-catalog:filters:v2", JSON.stringify({ query: "Daily", source: "example", scope: "", host: "", state: "unmonitored", project: "" }));
    const slot = await mount();
    fireEvent.click(await slot.findByRole("button", { name: "Показать все записи по фильтрам (1)" }));
    expect(slot.getByRole("button", { name: "Daily report" })).toBeTruthy();
    expect((slot.getByRole("textbox", { name: "Поиск автоматизаций" }) as HTMLInputElement).value).toBe("Daily");
    slot.lifecycle.unmount();
  });
  it("keeps summary counts consistent with search filters", async () => {
    const slot = await mount();
    await slot.findByRole("button", { name: "Daily report" });
    expect(slot.getByRole("button", { name: "Требуют проверки: 1" })).toBeTruthy();
    fireEvent.change(slot.getByRole("textbox", { name: "Поиск автоматизаций" }), { target: { value: "does not exist" } });
    fireEvent.click(slot.getByRole("button", { name: "Требуют проверки: 0" }));
    expect(slot.queryByRole("button", { name: "Daily report" })).toBeNull();
    slot.lifecycle.unmount();
  });
  it("opens current tasks by default and keeps registry records accessible separately", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      catalog_list: () => ({ tasks: [task, { ...task, key: "registry", name: "Registry example", state: "unknown", history: "not-connected", lastRun: null }], sources: [source] }),
    } });
    await slot.findByRole("button", { name: "Daily report" });
    expect(slot.queryByRole("button", { name: "Registry example" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: /Реестр без мониторинга/ }));
    expect(slot.getByRole("button", { name: "Registry example" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Daily report" })).toBeNull();
    slot.lifecycle.unmount();
  });
  it("uses the scheduler refresh RPC before reloading the table", async () => {
    const slot = await mount();
    await slot.findByText("Daily report");
    fireEvent.click(slot.getByRole("button", { name: "Обновить BB" }));
    await slot.findByText("BB обновлён. Остальные источники обновляются по своему расписанию.");
    expect(slot.inspection.rpcCalls.map((call) => call.method).slice(-2)).toEqual(["catalog_refresh", "catalog_list"]);
    slot.lifecycle.unmount();
  });
  it("counts attention only within the visible source and search filters", async () => {
    sessionStorage.setItem("bb:automation-catalog:filters:v2", JSON.stringify({ query: "no-match", source: "", scope: "", host: "", state: "", project: "" }));
    const slot = await mount();
    await slot.findByText("По заданным фильтрам автоматизаций нет.");
    const attention = slot.getByRole("button", { name: /Требуют внимания/ });
    expect(attention.textContent).toContain("0");
    fireEvent.click(attention);
    expect(slot.getByText("По заданным фильтрам автоматизаций нет.")).toBeTruthy();
    slot.lifecycle.unmount();
  });
  it("does not count a missing running record as a live execution", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      catalog_list: () => ({ tasks: [{ ...task, missing: true, nextRunAt: Date.now() - 1000,
        lastRun: { ...task.lastRun, status: "running" } }], sources: [source] }),
    } });
    const running = await slot.findByRole("button", { name: /Выполняются \/ в очереди/ });
    expect(running.textContent).toContain("0");
    expect(slot.queryByText(/Следующий запуск:/)).toBeNull();
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
    await slot.findByRole("button", { name: "Открыть родительский тред" });
    expect(
      slot.getAllByRole("textbox").at(-1)!.textContent ||
        (slot.getAllByRole("textbox").at(-1) as HTMLTextAreaElement).value,
    ).toContain("личную автоматизацию");
    expect(
      slot.inspection.rpcCalls.every((call) =>
        ["catalog_list", "catalog_detail", "catalog_compose_context"].includes(call.method),
      ),
    ).toBe(true);
    slot.lifecycle.unmount();
  });
  it("keeps ownership and destination correct when switching creation routes", async () => {
    const slot = await mount();
    await slot.findByText("Daily report");
    fireEvent.click(slot.getByRole("button", { name: "Создать автоматизацию" }));
    fireEvent.click(slot.getByRole("button", { name: /Серверная автоматизация/ }));
    await slot.findByRole("button", { name: "Открыть родительский тред" });
    const first = slot.getAllByRole("textbox").at(-1) as HTMLTextAreaElement;
    expect(first.value || first.textContent).toContain("личную автоматизацию");
    fireEvent.click(slot.getByRole("button", { name: "← Автоматизации" }));
    fireEvent.change(
      slot.getByRole("combobox", { name: "Тип автоматизации" }),
      { target: { value: "team" } },
    );
    fireEvent.click(slot.getByRole("button", { name: /Автоматизация BB/ }));
    await slot.findByRole("button", { name: "Открыть родительский тред" });
    const second = slot.getAllByRole("textbox").at(-1) as HTMLTextAreaElement;
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
