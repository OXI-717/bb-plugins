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
  expect(app.navPanels[0]!.title).toBe("OXI Automation Catalog");
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
  it("finds a paused task by prompt text across lifecycle sections", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const paused = { ...task, key: "ext_paused", state: "paused" };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      catalog_list: () => ({ tasks: [paused], sources: [source] }),
      catalog_search: () => ({ matches: [{ key: paused.key, excerpt: "Задание: Check team messages" }], unavailable: 0, checkedAt: Date.now() }),
    } });
    await slot.findByRole("button", { name: /Все записи/ });
    expect(slot.queryByRole("button", { name: "Daily report" })).toBeNull();
    fireEvent.change(slot.getByRole("textbox", { name: "Поиск автоматизаций" }), { target: { value: "Check team messages" } });
    expect(await slot.findByRole("button", { name: "Daily report" })).toBeTruthy();
    expect(await slot.findByText("Задание: Check team messages")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Разобрать проблемы (1)" })).toBeTruthy();
  });
  it("opens a catalog deep link and displays relay origin without starting a task", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "ext_sample" }, { rpc: {
      catalog_list: () => ({ tasks: [task], sources: [source] }),
      catalog_detail: () => ({ task: { ...task, projectId: "project_sample" }, source: { ...source, managedHere: true }, runs: [task.lastRun], total: 1 }),
      catalog_definition: () => ({ kind: "relay", prompt: "Check team messages", targetThreadId: "thr_target", targetTitle: "Team monitor", targetHost: "Remote worker", note: "Отправка задания в тред", nativeUrl: "/plugins/automations/automations/project_sample/auto_sample" }),
    } });
    expect(await slot.findByRole("button", { name: "Team monitor" })).toBeTruthy();
    expect(slot.getByText("Check team messages")).toBeTruthy();
    expect(slot.getByRole("link", { name: "Открыть расписание в BB" }).getAttribute("href")).toContain("auto_sample");
    expect(slot.getByRole("button", { name: "Отключить" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "← Автоматизации" }));
    expect(slot.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "catalog", options: { replace: true } });
  });
  it("requires a reason, reviews an incident, and updates both attention counts", async () => {
    const app = await loadPluginApp(() => import("./app"));
    let current = { ...task, review: null as null | { fingerprint: string; note: string; at: number } };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      catalog_list: () => ({ tasks: [current], sources: [source] }),
      catalog_detail: () => ({ task: current, source, runs: [current.lastRun], total: 1 }),
      catalog_review: (value: unknown) => {
        const input = value as { fingerprint: string; note: string | null };
        current = { ...current, review: input.note === null ? null : { fingerprint: input.fingerprint, note: input.note, at: Date.now() } };
        return { ok: true };
      },
    } });
    fireEvent.click(await slot.findByRole("button", { name: "Daily report" }));
    const review = await slot.findByRole("button", { name: "Отметить как разобранное" });
    expect(review.hasAttribute("disabled")).toBe(true);
    fireEvent.change(slot.getByRole("textbox", { name: "Почему сбой разобран" }), { target: { value: "Checked against source; no further action" } });
    fireEvent.click(review);
    await slot.findByRole("button", { name: "Вернуть во внимание" });
    fireEvent.click(slot.getByRole("button", { name: "← Автоматизации" }));
    await slot.findByRole("button", { name: "Разобрать проблемы (0)" });
    expect(slot.getByRole("button", { name: "Требуют проверки: 0" })).toBeTruthy();
  });
  it("opens an unsubmitted problem draft and restores the list on back", async () => {
    const slot = await mount();
    const button = await slot.findByRole("button", { name: "Разобрать проблемы (1)" });
    fireEvent.click(button);
    await slot.findByText(/Обсуждение будет вложено/);
    expect(slot.getByRole("heading", { name: "Разбор и очистка автоматизаций · 1" })).toBeTruthy();
    const input = slot.getAllByRole("textbox").at(-1) as HTMLTextAreaElement;
    expect(input.textContent || input.value).toContain("недоверенные данные");
    expect(input.textContent || input.value).toContain("Daily report");
    fireEvent.click(slot.getByRole("button", { name: "← Автоматизации" }));
    expect(slot.getByRole("button", { name: "Daily report" })).toBeTruthy();
    slot.lifecycle.unmount();
  });
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
    expect(slot.getByText(/Alpha · Машина/)).toBeTruthy();
    expect(slot.getByText(/Beta · Машина/)).toBeTruthy();
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
    fireEvent.click(slot.getByRole("button", { name: /Без подтверждения состояния/ }));
    expect(slot.getByRole("button", { name: "Registry example" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Daily report" })).toBeNull();
    slot.lifecycle.unmount();
  });
  it("keeps observed transient runs out of current schedules and the failures list", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const transient = { ...task, id: "demo-worker", key: "transient", name: "Temporary execution",
      scheduler: "systemd", schedule: null, scheduleKind: "once", executionId: "systemd:example",
      state: "failed", lastRun: { ...task.lastRun, taskId: "demo-worker", exitCode: 70 } };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      catalog_list: () => ({ tasks: [task, transient], sources: [source] }),
    } });
    await slot.findByRole("button", { name: "Daily report" });
    expect(slot.queryByRole("button", { name: "Temporary execution" })).toBeNull();
    fireEvent.change(slot.getByRole("combobox", { name: "Раздел автоматизаций" }), { target: { value: "executions" } });
    expect(slot.getByRole("button", { name: "Temporary execution" })).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Daily report" })).toBeNull();
    expect(slot.getAllByText("Ошибка").length).toBeGreaterThan(0);
    fireEvent.change(slot.getByRole("combobox", { name: "Раздел автоматизаций" }), { target: { value: "attention" } });
    // A one-off execution outcome is retained evidence, not a schedule incident:
    // it stays visible in «Разовые исполнения», while real failures stay actionable here.
    expect(slot.queryByRole("button", { name: "Temporary execution" })).toBeNull();
    expect(slot.getByRole("button", { name: "Daily report" })).toBeTruthy();
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
    expect(slot.getAllByText(/Последний запуск завершился ошибкой/)[0]).toBeTruthy();
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
        ["catalog_list", "catalog_detail", "catalog_compose_context", "catalog_display_names"].includes(call.method),
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


it("labels inventory findings with the affected automation, project and machine", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const native = { ...task, id: "auto_example", key: "ext_native", host: "host_example",
    projectId: "proj_example", projectName: null, lastRun: null };
  const finding = { ...task, key: "ext_finding", name: "OXI · unregistered · host_example",
    scheduler: "inventory-audit", sourceId: "inventory", host: "host_example", state: "blocked",
    description: 'Observed scheduler entry has no registry record. Identity: ["host_example","bb","proj_example","auto_example"]. No automatic stop.' };
  const inventory = { ...source, id: "inventory", name: "Registry comparison" };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    catalog_display_names: () => ({ hosts: [{ id: "host_example", name: "Office Mac" }],
      projects: [{ id: "proj_example", name: "Example project" }] }),
    catalog_list: () => ({ tasks: [native, finding, { ...finding, key: "ext_resolved",
      name: "OXI · resolved · host_example", state: "paused", lastRun: null }], sources: [{ ...source, managedHere: true }, inventory] }),
    catalog_detail: () => ({ task: finding, source: inventory, runs: [finding.lastRun], total: 1 }),
    catalog_audit_list: () => ({ records: [], total: 0 }),
  } });
  await slot.findByText(/Example project · Office Mac/);
  expect(slot.getByRole("option", { name: "Отключены (0)" })).toBeTruthy();
  fireEvent.change(slot.getByRole("combobox", { name: "Раздел автоматизаций" }), { target: { value: "registry" } });
  expect(slot.getAllByText("Нет в реестре").length).toBeGreaterThan(0);
  expect(slot.queryByText(/Заблокирована|host_example/)).toBeNull();
  fireEvent.change(slot.getByRole("combobox", { name: "Проект" }), { target: { value: "proj_example" } });
  fireEvent.click(slot.getByRole("button", { name: "Daily report" }));
  expect(await slot.findByRole("heading", { name: "Daily report" })).toBeTruthy();
  expect(slot.getByText(/Машина: Office Mac/)).toBeTruthy();
  expect(slot.queryByText("История запусков")).toBeNull();
  expect(slot.getByText(/История предупреждения/)).toBeTruthy();
  slot.lifecycle.unmount();
});

it("keeps historical sources in the archive while warning about a stale live source", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const historic = { ...source, id: "historic", name: "Past inspection", archivedAt: 23, lastSuccessAt: 1 };
  const live = { ...source, id: "live", name: "Current connection", lastSuccessAt: 1 };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
    catalog_display_names: () => ({ hosts: [], projects: [] }),
    catalog_list: () => ({
      tasks: [{ ...task, sourceId: live.id }, { ...task, name: "Archived observation",
        sourceId: historic.id, key: "ext_historic", state: "failed" }],
      sources: [live, historic],
    }),
  } });
  await slot.findByText(/Проверьте подключение: Current connection/);
  expect(slot.queryByText(/Проверьте подключение: Past inspection/)).toBeNull();
  expect(slot.queryByText("Archived observation")).toBeNull();
  fireEvent.change(slot.getByRole("combobox", { name: "Раздел автоматизаций" }), { target: { value: "archive" } });
  expect(slot.getByRole("button", { name: "Archived observation" })).toBeTruthy();
  expect(slot.getAllByText("Архив источника").length).toBeGreaterThan(0);
  slot.lifecycle.unmount();
});

describe("retained one-off observations", () => {
  it("keeps a disappeared running observation out of the running view", async () => {
    const app = await loadPluginApp(() => import("./app"));
    const retained = { ...task, name: "Одноразовое исполнение · sample.service", scheduler: "systemd", scheduleKind: "once", executionId: "systemd:invocation-example", state: "unknown", schedule: "Одноразовый процесс · без собственного расписания", lastRun: { ...task.lastRun, status: "running", finishedAt: null, exitCode: null } };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: {
      catalog_list: () => ({ tasks: [retained], sources: [source] }),
    } });
    fireEvent.click(await slot.findByRole("button", { name: /Все записи/ }));
    expect(await slot.findByRole("button", { name: retained.name })).toBeTruthy();
    expect(slot.getAllByText("Состояние не подтверждено").length).toBeGreaterThan(0);
    expect(slot.getAllByText(/Ранее наблюдался · текущий исход неизвестен/).length).toBeGreaterThan(0);
    if (process.env.CATALOG_VISUAL_DIR) {
      const fs = await import("node:fs/promises");
      await fs.mkdir(process.env.CATALOG_VISUAL_DIR, { recursive: true });
      const css = await fs.readFile(`${process.cwd()}/dist/app.css`, "utf8");
      await fs.writeFile(`${process.env.CATALOG_VISUAL_DIR}/unknown.html`, `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><body>${document.body.innerHTML}</body></html>`);
    }
    fireEvent.click(slot.getByRole("button", { name: /Выполняются \/ в очереди/ }));
    expect(slot.queryByRole("button", { name: retained.name })).toBeNull();
  });
});
