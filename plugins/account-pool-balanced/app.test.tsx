// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { version } from "./package.json";
import { egressStateSchema } from "./src/account-egress.js";
import type {
  AccountPoolConfig,
  AccountSummary,
  PoolStatus,
} from "./src/contracts.js";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const STATUS_CACHE_KEY = "account-pool:status";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function measureAccountRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const handle = this.querySelector(
        'button[aria-roledescription="sortable"]',
      );
      const rows = Array.from(this.parentElement?.children ?? []);
      return new DOMRect(0, handle ? rows.indexOf(this) * 60 : 0, 600, 60);
    },
  );
}

async function keyboardMove(handle: HTMLElement, code = "ArrowDown") {
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space" });
  await waitFor(() => expect(handle.getAttribute("aria-pressed")).toBe("true"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.keyDown(document, { code });
}

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    kind: "oauth",
    label: "person@example.com",
    email: "person@example.com",
    accountUuid: null,
    subscriptionType: "Max",
    rateLimitTier: "default_claude_max_5x",
    enabled: true, autopilotAllowed: false,
    priority: 100,
    createdAt: 1,
    lastUsedAt: 2,
    lastUsedHostId: "host-one",
    role: "primary",
    cap: null,
    lastUsedHostName: "bee",
    fiveHourUtilization: 0.21,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [],
    observedAt: 1,
    heldUntil: null,
    error: null,
    successfulRequests: 0,
    resetCredits: null,
    inFlight: 0,
    queuedRequests: 0, concurrencyLimit: 2,
    capLimit: null,
    eligible: true,
    capReached: false,
    drainOpensAt: null,
    status: "ready",
    ...overrides,
  };
}

function status(
  accounts: AccountSummary[] = [account()],
  activeAccounts: PoolStatus["activeAccounts"] = {
    claude: null,
    codex: null,
    kimi: null,
    zai: null,
    "opencode-go": null,
    neuraldeep: null, agy: null,
    cursor: null,
    devin: null,
    grok: null,
  },
): PoolStatus {
  return {
    route: "/api/v1/plugins/account-pool/http",
    enabledAccountCount: accounts.filter((item) => item.enabled).length,
    inFlight: 2,
    accepting: true,
    hosts: [
      { hostId: "host-one", hostName: "bee", mintedAt: 1, lastUsedAt: 2 },
    ],
    accounts,
    activeAccounts,
    routing: {
      claude: true,
      codex: true,
      kimi: true,
      zai: true,
      "opencode-go": true,
    neuraldeep: true, agy: true,
      cursor: true,
      devin: true,
      grok: true,
    },
  };
}

function config(overrides: Partial<AccountPoolConfig> = {}): AccountPoolConfig {
  return {
    pinnedFailover:false,
    anthropicUpstreamBaseUrl: "https://api.anthropic.com",
    codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
    kimiUpstreamBaseUrl: "https://api.kimi.com/coding/v1",
    zaiUpstreamBaseUrl: "https://api.z.ai/api/coding/paas/v4",
    opencodeGoUpstreamBaseUrl: "https://opencode.ai/zen/go/v1",
    opencodeFreeUpstreamBaseUrl: "https://opencode.ai/inference/openai/v1",
    neuraldeepUpstreamBaseUrl: "https://api.neuraldeep.ru/v1",
    cursorUpstreamBaseUrl: "https://api2.cursor.sh",
    devinUpstreamBaseUrl: "https://server.codeium.com",
    grokUpstreamBaseUrl: "https://api.x.ai/v1",
    maxConcurrentRequestsPerAccount: 2,
    claudeRequestStartIntervalMs: 0,
    switchThreshold: 0.98,
    routingStrategy: "sequential",
    reserveDrainHours: 24,
    restDays: [0, 6],
    vpnOnlyProviders: ["codex", "claude", "cursor", "devin"],
    vpnGuardEnabled: false,
    busyOverflow: true,
    vpnPolicyVersion:2,
    vpnStatusFile: null,
    browserHostId: null,
    ...overrides,
  };
}

function render(
  accounts = [account()],
  extraRpc: Record<string, () => object | null | Promise<object | null>> = {},
) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "status.get": () => status(accounts),
        "config.get": () => config(),
        "update.status": () => null,
        "native.accounts": () => ({managed: false, accounts: []}),
        ...extraRpc,
      },
      openUrl: () => true,
    },
  );
}

function egressSnapshot(accountId: string) {
  return egressStateSchema.parse({
    schema: 1,
    profiles: [{
      id: "prepared-egress",
      version: 2,
      label: "Тестовый выход",
      node: "test-exit",
      hostIds: ["host-one"],
      transport: "ssh-connect",
      endpoint: "http://127.0.0.1:19081",
      dns: "remote",
      ipv4: true,
      ipv6: false,
      failure: "closed",
      expectedExit: ["192.0.2.1"],
      assurance: "proxy-enforced",
    }],
    bindings: { [accountId]: { id: "prepared-egress", version: 2 } },
  });
}

async function openEgressSettings(slot: ReturnType<typeof render>) {
  fireEvent.click(await slot.findByRole("button", { name: "Открыть карточку: person@example.com" }));
  fireEvent.click(slot.getByText(/Доступ и маршрут/, { selector: "summary" }));
  await slot.findByRole("option", { name: "Тестовый выход", selected: true });
}

describe("Account Pool settings", () => {
  it("shows the Pooler version beside the update controls", async () => {
    const slot = render();
    const panel = slot.getByRole("region", { name: "Обновление Pooler" });
    expect(within(panel).getByText(`Версия Pooler ${version}`)).toBeTruthy();
    expect(await within(panel).findByRole("button", { name: "Обновить Pooler" })).toBeTruthy();
  });

  it("puts hub status at the bottom inside collapsed technical details", async () => {
    const slot = render();
    const hubStatus = await slot.findByText("Хаб принимает · 2 в работе · используют bee");
    const details = hubStatus.closest("details");
    expect(details?.open).toBe(false);
    const content = Array.from(details?.parentElement?.children ?? []).filter((element) => element.tagName !== "STYLE");
    expect(content.at(-1)).toBe(details);
    fireEvent.click(slot.getByText("Технические детали"));
    expect(details?.open).toBe(true);
  });

  it('starts the server updater from the pool interface and blocks repeated clicks',async()=>{
    const operation={operationId:'11111111-1111-4111-8111-111111111111',hostId:'host-one',terminalId:'terminal-one',startedAt:1,state:'running'};
    const start=vi.fn(async()=>operation);
    const slot=render([],{"update.start":start,"update.status":()=>start.mock.calls.length?operation:null});
    const button=await slot.findByRole('button',{name:'Обновить Pooler'});
    fireEvent.click(button);
    await slot.findByText('Подготовка и обновление выполняются. Работа возобновится автоматически.');
    expect(slot.getByRole('button',{name:'Проверяю обновление…'}).hasAttribute('disabled')).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(slot.getByText(/Новые сообщения подождут в очереди/)).toBeTruthy();
  });
  it("explains when the installed Pooler release is already current", async () => {
    const operation = {
      operationId: "11111111-1111-4111-8111-111111111111",
      hostId: "host-one", terminalId: "terminal-one", startedAt: 1,
      state: "succeeded", alreadyCurrent: true,
    };
    const start = vi.fn(async () => operation);
    const slot = render([], {"update.start": start, "update.status": () => start.mock.calls.length ? operation : null});
    fireEvent.click(await slot.findByRole("button", {name: "Обновить Pooler"}));
    expect((await slot.findByText("Уже установлена последняя версия.")).getAttribute("role")).toBe("status");
  });

  it('recovers update progress after reopening the interface',async()=>{
    const slot=render([],{"update.status":()=>({operationId:'11111111-1111-4111-8111-111111111111',hostId:'host-one',terminalId:'terminal-one',startedAt:1,state:'running'})});
    await slot.findByText('Подготовка и обновление выполняются. Работа возобновится автоматически.');
    expect(slot.getByRole('button',{name:'Проверяю обновление…'}).hasAttribute('disabled')).toBe(true);
  });
  it('shows status errors and disables starting until the server confirms the update state',async()=>{
    const start=vi.fn(async()=>null);
    const read=vi.fn(async()=>{throw new Error('Connection unavailable');});
    const slot=render([],{"update.status":read,"update.start":start});
    const message=await slot.findByText('Не удалось проверить состояние обновления. Запуск пока недоступен.');
    expect(message.getAttribute('role')).toBe('alert');
    expect(slot.getByRole('button',{name:'Обновить Pooler'}).hasAttribute('disabled')).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('opens the native card and saves the existing all-projects control',async()=>{
    const projects={onlySelected:true,rules:[{projectId:'project-one',role:'inherit' as const}]};
    const slot=render([],{"native.accounts":()=>({managed:true,selectionRevision:'b'.repeat(64),accounts:[{accountId:'subscription-one',projects,projectsRevision:'a'.repeat(64),mixedProjects:false,executors:[],active:0,queued:0,uncertain:0}]}),"native.updateAccount":()=>null});
    fireEvent.click(await slot.findByRole('button',{name:'Открыть Аккаунт Google'}));
    const control=await slot.findByLabelText('Где использовать');
    expect(control.closest('.pool-settings')).not.toBeNull();
    expect((control as HTMLSelectElement).value).toBe('selected');
    expect(await slot.findByLabelText('Роль в project-one')).toBeTruthy();
    fireEvent.change(control,{target:{value:'all'}});
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-one',projects:{...projects,onlySelected:false},expectedRevision:'b'.repeat(64)}}));
  });

  it('opens explicit settings and saves priority through the revision-bound action',async()=>{
    const slot=render([],{"native.accounts":()=>({managed:true,selectionRevision:'b'.repeat(64),accounts:[{
      accountId:'subscription-two',label:'Second Google',projects:{onlySelected:false,rules:[]},projectsRevision:'a'.repeat(64),mixedProjects:false,
      executors:[{id:'second-host',enabled:true,autopilotAllowed:false}],active:0,queued:0,uncertain:0,
    }]}),"native.updateAccount":()=>null});
    expect(await slot.findByRole('button',{name:'Открыть Second Google'})).toBeTruthy();
    expect(slot.queryByRole('button',{name:'Использовать'})).toBeNull();
    fireEvent.pointerDown(slot.getByRole('button',{name:'Действия: Second Google'}));
    fireEvent.click(await slot.findByText('Настроить'));
    const priority=await slot.findByLabelText('Приоритет аккаунта');
    fireEvent.change(priority,{target:{value:'2'}});fireEvent.blur(priority);
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',priority:2,expectedRevision:'b'.repeat(64)}}));
    const concurrency=await slot.findByLabelText('Одновременных сеансов') as HTMLSelectElement;
    await waitFor(()=>expect(concurrency.disabled).toBe(false));
    expect(concurrency.value).toBe('1');
    fireEvent.change(concurrency,{target:{value:'2'}});
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',maxConcurrentSessions:2,expectedRevision:'b'.repeat(64)}}));
  });

  it('offers higher native concurrency while sessions are active or queued',async()=>{
    const slot=render([],{"native.accounts":()=>({managed:true,selectionRevision:'c'.repeat(64),accounts:[{
      accountId:'subscription-two',label:'Second Google',projects:{onlySelected:false,rules:[]},projectsRevision:'a'.repeat(64),mixedProjects:false,
      executors:[{id:'second-host',enabled:true,autopilotAllowed:false}],active:2,queued:1,uncertain:0,maxConcurrentSessions:2,
    }]}),"native.updateAccount":()=>null});
    fireEvent.click(await slot.findByRole('button',{name:'Открыть Second Google'}));
    const concurrency=await slot.findByLabelText('Одновременных сеансов') as HTMLSelectElement;
    await waitFor(()=>expect(concurrency.disabled).toBe(false));
    expect(concurrency.value).toBe('2');
    expect((await slot.findByRole('option',{name:'1'}) as HTMLOptionElement).disabled).toBe(true);
    expect((await slot.findByRole('option',{name:'3'}) as HTMLOptionElement).disabled).toBe(false);
    fireEvent.change(concurrency,{target:{value:'3'}});
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',maxConcurrentSessions:3,expectedRevision:'c'.repeat(64)}}));
  });

  it('saves native role, project role and automation switches in the same account settings without legacy preference calls',async()=>{
    const item={accountId:'subscription-two',label:'Second Google',role:'primary',priority:1,projects:{onlySelected:false,rules:[{projectId:'project-one',role:'inherit'}]},projectsRevision:'a'.repeat(64),mixedProjects:false,executors:[{id:'second-host',enabled:true,autopilotAllowed:false}],active:0,queued:0,uncertain:0};
    const slot=render([],{"native.accounts":()=>({managed:true,selectionRevision:'b'.repeat(64),accounts:[item]}),"native.updateAccount":()=>null});
    fireEvent.click(await slot.findByRole('button',{name:'Открыть карточку: Second Google'}));
    fireEvent.change(await slot.findByLabelText('Роль по умолчанию'),{target:{value:'reserve'}});
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',expectedRevision:'b'.repeat(64),role:'reserve'}}));
    await waitFor(()=>expect(slot.getByLabelText('Разрешить автопилоту second-host').closest('fieldset')?.disabled).toBe(false));
    fireEvent.click(slot.getByLabelText('Разрешить автопилоту second-host'));
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',expectedRevision:'b'.repeat(64),executor:{id:'second-host',autopilotAllowed:true}}}));
    await waitFor(()=>expect(slot.getByLabelText('Роль в project-one').closest('fieldset')?.disabled).toBe(false));
    fireEvent.change(slot.getByLabelText('Роль в project-one'),{target:{value:'primary'}});
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',expectedRevision:'b'.repeat(64),projects:{onlySelected:false,rules:[{projectId:'project-one',role:'primary'}]}}}));
    expect(slot.rpcCalls.some(call=>call.method==='native.prefer')).toBe(false);
  });
  it('shows a useful error when native settings conflict instead of claiming a saved priority',async()=>{
    const slot=render([],{"native.accounts":()=>({managed:true,selectionRevision:'b'.repeat(64),accounts:[{accountId:'subscription-two',label:'Second Google',role:'primary',priority:1,projects:{onlySelected:false,rules:[]},projectsRevision:'a'.repeat(64),mixedProjects:false,executors:[],active:0,queued:0,uncertain:0}]}),"native.updateAccount":()=>{throw Error('native-selection-changed');}});
    fireEvent.click(await slot.findByRole('button',{name:'Открыть Second Google'}));
    fireEvent.change(slot.getByLabelText('Роль по умолчанию'),{target:{value:'reserve'}});
    await slot.findByText('Настройки изменились в другой сессии. Обновите данные и повторите.');
  });

  it("shows one official Google subscription across executors without an OAuth sign-in", async () => {
    const slot = render([], {"native.accounts": () => ({managed: true, accounts: [{accountId: "subscription-one", executors: [
      {id: "official-desktop", enabled: true, autopilotAllowed: false},
      {id: "official-worker", enabled: true, autopilotAllowed: true},
    ], active: 1, queued: 2, uncertain: 0, maxConcurrentSessions: 2}]})});
    const row = await slot.findByRole("button", { name: "Открыть Аккаунт Google" });
    expect(within(row).getByText("Включён")).toBeTruthy();
    expect(within(row).getByText("В очереди: 2")).toBeTruthy();
    expect(within(within(row).getByTitle("Сеансы в работе / предел")).getByText("1 / 2")).toBeTruthy();
    expect(within(row).queryByText("5Ч")).toBeNull();
    fireEvent.click(slot.getByText("Выбранные аккаунты", { selector: "summary" }));
    const overview = await slot.findByRole("region", { name: "Выбранные аккаунты" });
    expect(within(overview).getByText("Выбирается для сеанса")).toBeTruthy();
    expect(slot.queryByText("В пуле нет аккаунтов")).toBeNull();
    expect(slot.getByRole("switch", {name: "Направлять треды Antigravity"})).toBeTruthy();
    expect(slot.queryByRole("button", {name: "Добавить аккаунт Antigravity"})).toBeNull();
    expect(slot.rpcCalls.some(call => call.method.startsWith("agyLogin."))).toBe(false);
  });
  it("keeps managed routing available when the route was previously disabled", async () => {
    const slot=render([], {
      "native.accounts":()=>({managed:true,accounts:[]}),
      "status.get":()=>({...status([]),routing:{...status([]).routing,agy:false}}),
      "routing.set":()=>null,
    });
    await slot.findByText("Официальный клиент");
    const toggle=slot.getByRole("switch",{name:"Направлять треды Antigravity"});
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:"routing.set",input:{provider:"agy",enabled:true}}));
  });
  it("surfaces native registry failures without offering an OAuth retry", async () => {
    const slot=render([], {"native.accounts":()=>{throw Error("registry unavailable");}});
    await slot.findByText("Не удалось загрузить исполнителей: registry unavailable");
    expect(slot.getByRole("switch", {name:"Направлять треды Antigravity"})).toBeTruthy();
    expect(slot.rpcCalls.some(call=>call.method.startsWith("agyLogin."))).toBe(false);
  });
  it("shows the executor, kind, age and operator command for an uncertain lease", async () => {
    const leaseId = "11111111-1111-4111-8111-111111111111";
    const slot = render([], {"status.get": () => ({
      ...status([]),
      uncertainNativeLeases: [{leaseId, executorId:"example-executor", kind:"catalog", ageMs:125_000}],
    })});
    expect(await slot.findByText("example-executor · каталог · 2 мин")).toBeTruthy();
    expect(slot.getByText(`bb pool native attest-stopped ${leaseId} --confirmed`)).toBeTruthy();
  });

  it("marks uncertain execution and does not present it as ready", async () => {
    const slot = render([], {"native.accounts": () => ({managed: true, accounts: [{accountId: "subscription-one", executors: [
      {id: "official-desktop", enabled: true, autopilotAllowed: false},
    ], active: 0, queued: 0, uncertain: 1}]})});
    const row = await slot.findByRole("button", {name: "Открыть Аккаунт Google"});
    expect(within(row).getByText("Остановка не подтверждена: 1")).toBeTruthy();
    expect(within(row).queryByText("Включён")).toBeNull();
  });

  it("saves the explicit account permission with compare-and-set and reports conflicts", async () => {
    const slot=render([account()], {"account.setAutopilotAllowed":()=>{throw Error("permission changed");}});
    fireEvent.click(await slot.findByRole("button", {name:"Открыть карточку: person@example.com"}));
    fireEvent.click(slot.getByText(/Доступ и маршрут/, { selector: "summary" }));
    const checkbox=slot.getByRole("checkbox",{name:"Разрешить автопилоту"}) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    await slot.findByText("Не удалось сохранить разрешение. Обновите данные и повторите.");
    expect(slot.rpcCalls).toContainEqual({method:"account.setAutopilotAllowed",input:{accountId:account().id,allowed:true,expectedAllowed:false}});
    expect(checkbox.checked).toBe(false);
  });

  it("shows the assigned egress profile in ordinary account settings without an operator grant", async () => {
    const selected = account();
    const snapshot = egressSnapshot(selected.id);
    const slot = render([selected], { "egress.status": () => snapshot });
    await openEgressSettings(slot);

    expect(slot.getByRole("combobox", { name: "Выходной профиль" }).hasAttribute("disabled")).toBe(false);
    expect(slot.rpcCalls).toContainEqual({ method: "egress.status", input: null });
    expect(slot.rpcCalls.some(({ method }) =>
      ["management.call", "egress.bind", "egress.proxy"].includes(method)
    )).toBe(false);
  });

  it("shows the full display name for an existing assigned profile", async () => {
    const selected = account();
    const snapshot = egressSnapshot(selected.id);
    const slot = render([selected], {
      "egress.status": () => ({...snapshot, displayNames: {"prepared-egress:2": "full-node-name"}}),
    });
    fireEvent.click(await slot.findByRole("button", {name: "Открыть карточку: person@example.com"}));
    fireEvent.click(slot.getByText(/Доступ и маршрут/, {selector: "summary"}));
    await slot.findByRole("option", {name: "full-node-name", selected: true});
    expect(slot.queryByRole("option", {name: "Тестовый выход"})).toBeNull();
  });

  it("lists each exit once and keeps the assigned version until the user applies a change", async () => {
    const selected = account();
    const snapshot = egressSnapshot(selected.id);
    const newest = snapshot.profiles[0]!;
    const previous = { ...newest, version: 1, hostIds: ["previous-host"] };
    const otherExit = { ...newest, id: "other-exit", version: 1, label: "Другой выход" };
    const slot = render([selected], {
      "egress.status": () => ({
        ...snapshot,
        profiles: [newest, previous, otherExit],
        bindings: { [selected.id]: { id: previous.id, version: previous.version } },
        displayNames: { "prepared-egress:2": "Основной выход" },
      }),
      "egress.bind": () => null,
    });
    fireEvent.click(await slot.findByRole("button", { name: "Открыть карточку: person@example.com" }));
    fireEvent.click(slot.getByText(/Доступ и маршрут/, { selector: "summary" }));

    await slot.findByRole("option", { name: "Основной выход", selected: true });
    const profile = slot.getByRole("combobox", { name: "Выходной профиль" });
    expect(within(profile).getAllByRole("option").map(option => option.textContent)).toEqual([
      "Текущий маршрут Pooler", "Основной выход", "Другой выход",
    ]);
    expect(slot.getByText(/Поддерживаемые хосты: previous-host/)).toBeTruthy();
    expect(slot.rpcCalls.some(({ method }) => method === "egress.bind")).toBe(false);

    fireEvent.click(slot.getByRole("button", { name: "Применить актуальную конфигурацию" }));
    expect(slot.rpcCalls).toContainEqual({
      method: "egress.bind", input: { accountId: selected.id, ref: { id: newest.id, version: newest.version } },
    });
    await waitFor(() => expect(profile.hasAttribute("disabled")).toBe(false));
    fireEvent.change(profile, { target: { value: otherExit.id } });
    expect(slot.rpcCalls).toContainEqual({
      method: "egress.bind", input: { accountId: selected.id, ref: { id: otherExit.id, version: otherExit.version } },
    });
  });

  it("saves a profile and proxy through the ordinary account settings and reloads the profile", async () => {
    const selected = account();
    const snapshot = egressSnapshot(selected.id);
    const statusRpc = vi.fn(() => snapshot)
      .mockReturnValueOnce(snapshot)
      .mockReturnValueOnce({ ...snapshot, bindings: {} });
    const slot = render([selected], {
      "egress.status": statusRpc,
      "egress.bind": () => null,
      "egress.proxy": () => null,
    });
    await openEgressSettings(slot);

    const profile = slot.getByRole("combobox", { name: "Выходной профиль" });
    const proxy = slot.getByLabelText("Прокси аккаунта");
    fireEvent.change(profile, { target: { value: "" } });
    await slot.findByRole("option", { name: "Текущий маршрут Pooler", selected: true });

    const url = "http://proxy.example:8080";
    fireEvent.change(proxy, { target: { value: url } });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить прокси" }));
    await slot.findByRole("option", { name: "Тестовый выход", selected: true });
    expect(statusRpc).toHaveBeenCalledTimes(3);
    expect(slot.rpcCalls).toContainEqual({ method: "egress.bind", input: { accountId: selected.id, ref: null } });
    expect(slot.rpcCalls).toContainEqual({ method: "egress.proxy", input: { accountId: selected.id, url } });
    expect(slot.rpcCalls.some(({ method }) => method.startsWith("management."))).toBe(false);
  });

  it("opens the selected account browser from its menu", async () => {
    const selected = account();
    const slot = render([selected], { "browser.open": () => ({ opened: true }) });
    fireEvent.pointerDown(await slot.findByRole("button", { name: "Действия: person@example.com" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Открыть в браузере" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "browser.open", input: { accountId: selected.id } }));
    await slot.findByText("Браузер открыт на машине Pooler.");
  });

  it("opens a pasted authorization link in the selected profile without adding an account", async () => {
    const selected = account();
    const response = deferred<object>();
    const slot = render([selected], { "browser.open": () => response.promise });
    fireEvent.click(await slot.findByRole("button", { name: "Открыть person@example.com" }));
    fireEvent.click(slot.getByText("Аккаунт и действия", { selector: "summary" }));
    const dialog = within(slot.getByRole("region", { name: "person@example.com" }));
    expect(dialog.queryByRole("textbox", { name: "Ссылка для открытия" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Открыть другую ссылку" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Ссылка для открытия" }), { target: { value: "https://login.example/authorize?state=synthetic" } });
    fireEvent.click(dialog.getByRole("button", { name: "Открыть ссылку" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "browser.open", input: { accountId: selected.id, url: "https://login.example/authorize?state=synthetic" } }));
    expect(dialog.getByRole("button", { name: "Открываю…" }).hasAttribute("disabled")).toBe(true);
    await act(async () => response.resolve({ opened: true }));
    await dialog.findByText("Браузер открыт на машине Pooler.");
    expect(slot.rpcCalls.some(call => call.method === "account.add")).toBe(false);
  });

  it("keeps browser errors in the card and permits retry without losing the link", async () => {
    let attempts = 0;
    const slot = render([account()], { "browser.open": () => { if (++attempts === 1) throw new Error("VPN confirmation unavailable"); return { opened: true }; } });
    fireEvent.click(await slot.findByRole("button", { name: "Открыть person@example.com" }));
    fireEvent.click(slot.getByText("Аккаунт и действия", { selector: "summary" }));
    const dialog = within(slot.getByRole("region", { name: "person@example.com" }));
    expect(dialog.queryByRole("textbox", { name: "Ссылка для открытия" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Открыть другую ссылку" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "Ссылка для открытия" }), { target: { value: "https://login.example/" } });
    fireEvent.click(dialog.getByRole("button", { name: "Открыть ссылку" }));
    await dialog.findByText("VPN confirmation unavailable");
    expect((dialog.getByRole("textbox", { name: "Ссылка для открытия" }) as HTMLInputElement).value).toBe("https://login.example/");
    fireEvent.click(dialog.getByRole("button", { name: "Открыть ссылку" }));
    await dialog.findByText("Браузер открыт на машине Pooler.");
  });

  it("shows a new OAuth failure instead of a previous browser failure", async () => {
    const slot = render([account()], {
      "browser.open": () => { throw new Error("Synthetic browser VPN failure"); },
      "login.reauthorize": () => { throw new Error("Synthetic OAuth failure"); },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Открыть person@example.com" }));
    fireEvent.click(slot.getByText("Аккаунт и действия", { selector: "summary" }));
    fireEvent.click(within(slot.getByRole("region", { name: "person@example.com" })).getByRole("button", { name: "Открыть в браузере" }));
    await within(slot.getByRole("region", { name: "person@example.com" })).findByText("Synthetic browser VPN failure");
    fireEvent.pointerDown(slot.getByRole("button", { name: "Другие действия аккаунта" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Авторизоваться заново" }));
    await within(slot.getByRole("dialog")).findByText("Synthetic OAuth failure");
    expect(slot.queryByText("Synthetic browser VPN failure")).toBeNull();
  });

  it("opens the existing reauthorization URL in that account profile", async () => {
    const selected = account();
    const slot = render([selected], {
      "login.reauthorize": () => ({ sessionId: "fixture-session", authorizeUrl: "https://login.example/authorize?state=synthetic", expiresAt: Date.now() + 600000 }),
      "browser.open": () => ({ opened: true }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Открыть person@example.com" }));
    fireEvent.click(slot.getByText("Аккаунт и действия", { selector: "summary" }));
    fireEvent.pointerDown(slot.getByRole("button", { name: "Другие действия аккаунта" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Авторизоваться заново" }));
    fireEvent.click(await slot.findByRole("button", { name: "Открыть в профиле аккаунта" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "browser.open", input: { accountId: selected.id, url: "https://login.example/authorize?state=synthetic" } }));
  });
  it.each(['start','complete'])('shows a Claude reauthorization %s error and offers retry',async stage=>{
    const selected=account();
    const failure='Вы вошли в другой аккаунт';
    const slot=render([selected],{
      'login.reauthorize':()=>{if(stage==='start')throw new Error(failure);return {sessionId:'fixture-session',authorizeUrl:'https://login.example/authorize',expiresAt:Date.now()+600000};},
      'login.complete':()=>{throw new Error(failure);},
    });
    fireEvent.click(await slot.findByRole('button',{name:'Открыть person@example.com'}));
    fireEvent.click(slot.getByText("Аккаунт и действия", { selector: "summary" }));
    fireEvent.pointerDown(slot.getByRole("button", { name: "Другие действия аккаунта" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Авторизоваться заново" }));
    if(stage==='complete'){
      fireEvent.change(await slot.findByRole('textbox',{name:'Код авторизации Claude'}),{target:{value:'code#state'}});
      fireEvent.click(slot.getByRole('button',{name:'Завершить'}));
    }
    await within(slot.getByRole('dialog')).findByText(failure);
    expect(slot.getByRole('button',{name:'Попробовать снова'})).toBeTruthy();
  });
  it("reauthorizes the selected disabled account rather than adding another account", async () => {
    const selected=account({enabled:false,status:'disabled',error:'[OAUTH_REAUTH_REQUIRED] OAuth refresh failed with HTTP 400.'});
    const slot=render([selected],{'login.reauthorize':()=>({sessionId:'fixture-session',authorizeUrl:'https://login.example/authorize',expiresAt:Date.now()+600000})});
    fireEvent.click(await slot.findByRole('button',{name:'Открыть person@example.com'}));
    fireEvent.click(slot.getByText("Аккаунт и действия", { selector: "summary" }));
    fireEvent.pointerDown(slot.getByRole("button", { name: "Другие действия аккаунта" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Авторизоваться заново" }));
    await slot.findByText('Повторная авторизация Claude');
    expect(slot.rpcCalls).toContainEqual({method:'login.reauthorize',input:{accountId:selected.id}});
    expect(slot.rpcCalls.some(call=>call.method==='login.start')).toBe(false);
    expect(slot.getByText(/Войдите именно в person@example.com/)).toBeTruthy();
  });
  it("keeps the account card open through debounce and in-flight policy save", async () => {
    const selected = account();
    const response = deferred<object>();
    const slot = render([selected], { "account.setPolicy": () => response.promise });
    fireEvent.click(await slot.findByRole("button", { name: "Открыть person@example.com" }));
    fireEvent.click(slot.getByText(/Доступ и маршрут/, { selector: "summary" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Индивидуальные настройки" }));
    fireEvent.click(slot.getByRole("button", { name: "Свернуть" }));
    expect(slot.getByRole("region", { name: "person@example.com" })).toBeTruthy();
    fireEvent.keyDown(slot.getByRole("region", { name: "person@example.com" }), { key: "Escape" });
    expect(slot.getByRole("region", { name: "person@example.com" })).toBeTruthy();
    await waitFor(() => expect(slot.rpcCalls.some(call => call.method === "account.setPolicy")).toBe(true));
    fireEvent.click(slot.getByRole("button", { name: "Свернуть" }));
    expect(slot.getByRole("region", { name: "person@example.com" })).toBeTruthy();
    await act(async () => { response.resolve({ account: selected }); });
    await slot.findByText("Настройки сохранены");
    fireEvent.click(slot.getByRole("button", { name: "Свернуть" }));
    await waitFor(() => expect(slot.queryByRole("region", { name: "person@example.com" })).toBeNull());
  });

  it("toggles one-shot draining in the account card", async () => {
    const selected = account({ drainOnce: false });
    const slot = render([selected], { "account.setDrainOnce": () => {
      selected.drainOnce = !selected.drainOnce;
      return { account: selected };
    } });
    fireEvent.click(await slot.findByRole("button", { name: "Открыть person@example.com" }));
    const checkbox = slot.getByRole("checkbox", { name: "Использовать до исчерпания" });
    fireEvent.click(checkbox);
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({
      method: "account.setDrainOnce", input: { accountId: selected.id, enabled: true },
    }));
    await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(true));
    fireEvent.click(checkbox);
    await waitFor(() => expect((checkbox as HTMLInputElement).checked).toBe(false));
  });

  it("does not load or overwrite a persisted account inventory cache", async () => {
    window.localStorage.setItem(
      STATUS_CACHE_KEY,
      JSON.stringify(status([account({ fiveHourUtilization: 0.21 })])),
    );
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    expect(slot.queryByText("person@example.com")).toBeNull();
    expect(slot.queryByText("21%")).toBeNull();
    expect(slot.getAllByText("Загрузка…").length).toBeGreaterThan(0);
    expect(slot.queryByText("В пуле нет аккаунтов")).toBeNull();
    live.resolve(status([account({ fiveHourUtilization: 0.6 })]));
    expect(await slot.findByText("60%")).toBeTruthy();
    expect(slot.queryByText("обновляю квоты…")).toBeNull();
    expect(slot.queryByText(/· обновляю…$/)).toBeNull();
    const cached = JSON.parse(
      window.localStorage.getItem(STATUS_CACHE_KEY) ?? "null",
    ) as PoolStatus;
    expect(cached.accounts[0]?.fiveHourUtilization).toBe(0.21);
  });

  it("ignores a malformed status cache and shows the loading state", async () => {
    window.localStorage.setItem(STATUS_CACHE_KEY, '{"accounts":"nope"}');
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    const providerLoaders = slot.getAllByText("Загрузка…").filter(element => !element.closest("details"));
    expect(providerLoaders).toHaveLength(10);
    live.resolve(status());
    expect(await slot.findByText("person@example.com")).toBeTruthy();
  });

  it("marks a row as refreshing while its usage refresh is in flight", async () => {
    const refresh = deferred<{ account: null }>();
    const slot = render([account()], {
      "account.refreshUsage": () => refresh.promise,
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "Действия: person@example.com" }),
    );
    fireEvent.click(await slot.findByText("Обновить квоты"));
    expect(await slot.findByText("обновляю квоты…")).toBeTruthy();
    refresh.resolve({ account: null });
    await waitFor(() => expect(slot.queryByText("обновляю квоты…")).toBeNull());
  });

  it("shows an unknown shared quota and omits unreported family windows", async () => {
    const slot = render();
    expect(await slot.findByText("person@example.com")).toBeTruthy();
    expect(slot.getByText("5Ч")).toBeTruthy();
    expect(slot.getByText("7Д")).toBeTruthy();
    expect(slot.queryByText("FABLE")).toBeNull();
    expect(slot.getByText("—")).toBeTruthy();
  });

  it("keeps the quota slots visible at mobile widths", async () => {
    const slot = render();
    const group = (await slot.findByText("5Ч")).parentElement?.parentElement;
    expect(group).toBeTruthy();
    expect(group?.className).not.toMatch(/(^|\s)hidden(\s|$)/u);
  });

  it("renders only the windows a Codex account reports and no Fable slot", async () => {
    const blockingResetAt = Date.now() + 6 * 24 * 60 * 60 * 1_000;
    const slot = render([
      account({
        id: "22222222-2222-4222-8222-222222222222",
        provider: "codex",
        label: "pro@example.com",
        email: "pro@example.com",
        codexAccountId: "chatgpt-account",
        status: "exhausted",
        fiveHourUtilization: 0.25,
        fiveHourResetAt: Date.now() + 60 * 60 * 1_000,
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 10_080,
            utilization: 1,
            resetAt: blockingResetAt,
            status: "rejected",
            observedAt: 1,
            source: "usage",
          },
        ],
      }),
    ]);
    expect(await slot.findByText("pro@example.com")).toBeTruthy();
    expect(slot.getByText("7Д")).toBeTruthy();
    expect(slot.getByText("100%")).toBeTruthy();
    expect(slot.getByText("5Ч")).toBeTruthy();
    expect(slot.queryByText("FABLE")).toBeNull();
    expect(
      slot.getByText(text => text.startsWith(
        `Исчерпан · сброс ${new Intl.DateTimeFormat("ru-RU", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Moscow" }).format(blockingResetAt)} МСК`,
      )),
    ).toBeTruthy();
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Открыть карточку: pro@example.com",
      }),
    );
    expect(await slot.findByText("Неделя")).toBeTruthy();
    expect(slot.getByText("5 часов")).toBeTruthy();
    expect(slot.queryByText("7 дней")).toBeNull();
  });

  it.each([
    {
      action: "Выключить",
      method: "account.disable",
      input: { id: account().id },
    },
    {
      action: "Обновить квоты",
      method: "account.refreshUsage",
      input: { accountId: account().id },
    },
  ])(
    "dispatches $action to its RPC contract",
    async ({ action, method, input }) => {
      const slot = render([account()], {
        [method]: () => ({ account: null }),
      });
      fireEvent.pointerDown(
        await slot.findByRole("button", {
          name: "Действия: person@example.com",
        }),
      );
      fireEvent.click(await slot.findByText(action));
      expect(slot.rpcCalls).toContainEqual({ method, input });
    },
  );

  it("confirms Remove before dispatching its RPC contract", async () => {
    const slot = render([account()], {
      "account.remove": () => ({ removed: true }),
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "Действия: person@example.com" }),
    );
    fireEvent.click(await slot.findByText("Удалить"));
    expect(await slot.findByText("Удалить person@example.com?")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "account.remove")).toBe(
      false,
    );
    fireEvent.click(slot.getByRole("button", { name: "Удалить" }));
    expect(slot.rpcCalls).toContainEqual({
      method: "account.remove",
      input: { id: account().id },
    });
  });

  it("opens the correct provider sign-in flow from each Add account menu", async () => {
    const slot = render([], {
      "login.start": () => ({
        sessionId: "22222222-2222-4222-8222-222222222222",
        authorizeUrl: "https://claude.ai/oauth/authorize",
      }),
      "codexLogin.start": () => ({
        sessionId: "33333333-3333-4333-8333-333333333333",
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: Date.now() + 600_000,
        intervalMs: 60_000,
      }),
    });
    const addButtons = await slot.findAllByRole("button", {
      name: "Добавить аккаунт",
    });
    fireEvent.pointerDown(addButtons[0]!);
    fireEvent.click(
      await slot.findByText("Вход в Claude", { selector: "span.block" }),
    );
    expect(await slot.findByLabelText("Код авторизации Claude")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Закрыть" }));
    fireEvent.pointerDown(addButtons[1]!);
    fireEvent.click(
      await slot.findByText("Вход в Codex", { selector: "span.block" }),
    );
    expect(
      (await slot.findByLabelText("Код устройства Codex")).textContent,
    ).toContain("ABCD-1234");
  });

  it("offers Antigravity Google login without paid key or local credential import",async()=>{
    const slot=render([],{'agyLogin.cancel':()=>({cancelled:true}),'agyLogin.start':()=>({sessionId:'synthetic-session',authorizeUrl:'https://accounts.google.com/o/oauth2/v2/auth',expiresAt:Date.now()+600000})});
    await slot.findByRole('switch',{name:'Направлять треды Antigravity'});
    const buttons=await slot.findAllByRole('button',{name:'Добавить аккаунт'});
    fireEvent.pointerDown(buttons[4]!);
    fireEvent.click(await slot.findByText('Вход в Antigravity',{selector:'span.block'}));
    expect(await slot.findByLabelText('Код авторизации Google')).toBeTruthy();
    expect(slot.queryByText('Добавить API-ключ…')).toBeNull();
    expect(slot.queryByText('Импорт с этой машины')).toBeNull();
    fireEvent.click(slot.getByRole('button',{name:'Закрыть'}));
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'agyLogin.cancel',input:{sessionId:'synthetic-session'}}));
  });

  it("adds a Devin PAT from its card without offering Codex login", async () => {
    const slot = render([], { "account.add": () => account({ provider: "devin" }) });
    await slot.findByRole("switch", {name:"Направлять треды Antigravity"});
    const addButtons = await slot.findAllByRole("button", { name: "Добавить аккаунт" });
    fireEvent.pointerDown(addButtons[8]!);
    expect(slot.queryByText("Вход в Codex", { selector: "span.block" })).toBeNull();
    fireEvent.click(await slot.findByText("Добавить PAT…"));
    const dialog = await slot.findByRole("dialog", { name: "Добавить PAT Devin" });
    fireEvent.change(slot.getByLabelText("Devin PAT"), { target: { value: "cog_synthetic" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Добавить ключ" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({
      method: "account.add",
      input: { provider: "devin", source: { kind: "api-key", apiKey: "cog_synthetic" }, label: null, priority: 100 },
    }));
  });

  it("persists provider routing from the section switch", async () => {
    const slot = render([account()], {
      "routing.set": () => ({ provider: "claude", enabled: false }),
    });
    fireEvent.click(
      await slot.findByRole("switch", { name: "Направлять треды Claude" }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "routing.set",
        input: { provider: "claude", enabled: false },
      }),
    );
  });

  it("shows shared provider pressure and validates the per-account request limit",async()=>{
    const slot=render([account({inFlight:1,queuedRequests:3})],{"config.set":()=>config({maxConcurrentRequestsPerAccount:1})});
    expect(await slot.findByText(/В работе: 1; в очереди: 3/)).toBeTruthy();
    fireEvent.click(await slot.findByRole("button",{name:"Дополнительно"}));
    const input=await slot.findByLabelText("Одновременных запросов на аккаунт");
    fireEvent.change(input,{target:{value:"0"}});fireEvent.blur(input);
    expect(await slot.findByText("Нужно целое число от 1 до 32.")).toBeTruthy();
    expect(slot.rpcCalls.filter(c=>c.method==="config.set")).toHaveLength(0);
    fireEvent.change(input,{target:{value:"1"}});fireEvent.blur(input);
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:"config.set",input:{maxConcurrentRequestsPerAccount:1}}));
  });

  it("edits Advanced config fields and shows URL validation inline", async () => {
    const nextConfig = config({
      anthropicUpstreamBaseUrl: "https://proxy.example.com",
    });
    const slot = render([account()], {
      "config.set": () => nextConfig,
    });
    fireEvent.click(await slot.findByRole("button", { name: "Дополнительно" }));
    const anthropic = await slot.findByLabelText(
      "Базовый URL upstream Anthropic",
    );
    if (!(anthropic instanceof HTMLInputElement)) {
      throw new Error("Expected the Anthropic config field to be an input.");
    }
    await waitFor(() =>
      expect(anthropic.value).toBe("https://api.anthropic.com"),
    );
    expect(slot.getByLabelText("Базовый URL upstream Codex")).toBeTruthy();
    expect(slot.getByLabelText("Порог переключения по квоте")).toBeTruthy();

    fireEvent.change(anthropic, { target: { value: "ftp://invalid.example" } });
    fireEvent.blur(anthropic);
    expect(await slot.findByText("Нужен адрес http или https.")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "config.set")).toBe(
      false,
    );

    fireEvent.change(anthropic, {
      target: { value: "https://proxy.example.com" },
    });
    fireEvent.blur(anthropic);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { anthropicUpstreamBaseUrl: "https://proxy.example.com" },
      }),
    );
  });

  it("opens the quota card between its row and the next account, and saves a rule", async () => {
    const resetAt = Date.now() + (3 * 24 + 4) * 3_600_000;
    const selected = account({
      sevenDayUtilization: 0.52,
      sevenDayResetAt: resetAt,
      fiveHourUtilization: 1,
      fiveHourResetAt: Date.now() + 3_600_000,
      weeklySpending: { mode: "fixed", ceiling: 0.65, utilization: 0.52, resetAt, nextChangeAt: null },
    });
    const next = account({ id: "22222222-2222-4222-8222-222222222222", email: "next@example.com" });
    const slot = render([selected, next], { "account.setWeeklyBudget": () => ({ account: selected }) });
    const row = await slot.findByRole("button", { name: "Открыть person@example.com" });
    expect(within(row).getByText(/80% от потолка/)).toBeTruthy();
    expect(within(row).getByText(/через 3 д 4 ч/)).toBeTruthy();
    const short = within(row).getByText("5Ч").parentElement!;
    expect(within(short).getByText(/лимит достигнут/)).toBeTruthy();
    fireEvent.click(row);
    const card = slot.getByRole("region", { name: "person@example.com" });
    expect(row.getAttribute("aria-controls")).toBe(card.id);
    expect(card.parentElement?.contains(row)).toBe(true);
    expect(card.compareDocumentPosition(slot.getByRole("button", { name: "Открыть next@example.com" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rule = within(card).getByRole("region", { name: "Недельное правило" });
    fireEvent.click(within(rule).getByRole("button", { name: "Изменить недельное правило" }));
    fireEvent.change(within(rule).getByRole("combobox", { name: "Режим" }), { target: { value: "scheduled" } });
    fireEvent.click(within(rule).getByRole("button", { name: "Сохранить недельное правило" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "account.setWeeklyBudget", input: {
      accountId: selected.id, expected: null,
      change: { kind: "rule", rule: { mode: "scheduled", ceiling: 50, steps: [
        { hoursBeforeReset: 48, ceiling: 65 }, { hoursBeforeReset: 24, ceiling: 80 },
      ] } },
    } }));
  });

  it("marks the current account, reserve role, and live cap in each row", async () => {
    const work = account({
      id: "22222222-2222-4222-8222-222222222222",
      label: "work@example.com",
      email: "work@example.com",
      role: "reserve",
      capLimit: 0.39,
    });
    const slot = render([account(), work], {
      "status.get": () =>
        status([account(), work], {
          claude: account().id,
          codex: null,
          kimi: null,
          zai: null,
          "opencode-go": null,
    neuraldeep: null, agy: null,
          cursor: null,
          devin: null,
          grok: null,
        }),
    });
    const overviewTrigger = await slot.findByText("Выбранные аккаунты", { selector: "summary" });
    const details = overviewTrigger.closest("details");
    expect(details?.open).toBe(false);
    const advancedTrigger = slot.getByRole("button", { name: "Дополнительно" });
    expect(advancedTrigger.compareDocumentPosition(overviewTrigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(overviewTrigger);
    expect(details?.open).toBe(true);
    expect(within(slot.getByRole("region", { name: "Выбранные аккаунты" })).getAllByText("Не выбран")).toHaveLength(9);
    expect(slot.getAllByText("Текущий")).toHaveLength(1);
    expect(slot.getAllByText("Резерв")).toHaveLength(1);
    expect(slot.getByText("потолок сейчас 39% (15%→98%)")).toBeTruthy();
  });

  it("uses email instead of display names in the overview, rows and account dialog", async () => {
    const named = account({ label: "Synthetic Display Name", email: "identity@example.com" });
    const slot = render([named], {
      "status.get": () => status([named], { claude: named.id, codex: null, kimi: null, zai: null, "opencode-go": null,
    neuraldeep: null, agy: null, cursor: null, devin: null, grok: null }),
    });
    fireEvent.click(await slot.findByText("Выбранные аккаунты", { selector: "summary" }));
    const overview = await slot.findByRole("region", { name: "Выбранные аккаунты" });
    expect(within(overview).getByText("identity@example.com")).toBeTruthy();
    expect(slot.queryByText("Synthetic Display Name")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Открыть identity@example.com" }));
    expect(await slot.findByRole("heading", { name: "identity@example.com" })).toBeTruthy();
    expect(slot.queryByText("Synthetic Display Name")).toBeNull();
  });

  it("shows missing email explicitly instead of a display name", async () => {
    const slot = render([account({ label: "Hidden Name", email: null })]);
    expect(await slot.findByRole("button", { name: "Открыть Email не указан" })).toBeTruthy();
    expect(slot.queryByText("Hidden Name")).toBeNull();
  });

  it("changes a reserve account to primary from inside its detail dialog", async () => {
    const reserved = account({ role: "reserve" });
    const slot = render([reserved], { "account.setRole": () => ({ account: reserved }) });
    fireEvent.click(await slot.findByRole("button", { name: "Открыть person@example.com" }));
    fireEvent.click(slot.getByText(/Доступ и маршрут/, { selector: "summary" }));
    fireEvent.click(await slot.findByRole("button", { name: "Изменить роль" }));
    fireEvent.click(await slot.findByRole("button", { name: "Основной" }));
    fireEvent.click(slot.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "account.setRole", input: { accountId: reserved.id, role: "primary" } }));
  });

  it("names the delete confirmation with the selected email", async () => {
    const slot = render([account({ label: "Shared Display Name", email: "selected@example.com" })]);
    fireEvent.click(await slot.findByRole("button", { name: "Открыть selected@example.com" }));
    fireEvent.click(slot.getByText("Аккаунт и действия", { selector: "summary" }));
    fireEvent.pointerDown(slot.getByRole("button", { name: "Другие действия аккаунта" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Удалить" }));
    expect(await slot.findByRole("dialog", { name: "Удалить selected@example.com?" })).toBeTruthy();
    expect(slot.queryByText("Shared Display Name")).toBeNull();
  });

  it("keeps role selection open and reports a rejected save", async () => {
    const slot = render([account({ role: "reserve" })], {
      "account.setRole": () => { throw new Error("Role update failed"); },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Открыть person@example.com" }));
    fireEvent.click(slot.getByText(/Доступ и маршрут/, { selector: "summary" }));
    fireEvent.click(await slot.findByRole("button", { name: "Изменить роль" }));
    fireEvent.click(await slot.findByRole("button", { name: "Основной" }));
    fireEvent.click(slot.getByRole("button", { name: "Сохранить" }));
    expect(await within(slot.getByRole("dialog", { name: "Роль" })).findByRole("alert")).toHaveProperty("textContent", "Role update failed");
    expect(slot.getByRole("button", { name: "Основной" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("saves a role and a weekly cap from the row actions", async () => {
    const slot = render([account()], {
      "account.setRole": () => ({ account: null }),
      "account.setCap": () => ({ account: null }),
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "Действия: person@example.com" }),
    );
    fireEvent.click(await slot.findByText("Задать роль…"));
    fireEvent.click(await slot.findByRole("button", { name: "Резерв" }));
    fireEvent.click(slot.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.setRole",
        input: { accountId: account().id, role: "reserve" },
      }),
    );
    await waitFor(() => expect(slot.queryByText("Роль")).toBeNull());
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "Действия: person@example.com" }),
    );
    fireEvent.click(await slot.findByText("Задать плавный недельный потолок…"));
    fireEvent.change(await slot.findByLabelText("Потолок в начале недели"), {
      target: { value: "0.2" },
    });
    fireEvent.change(slot.getByLabelText("Потолок к сбросу"), {
      target: { value: "0.9" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.setCap",
        input: { accountId: account().id, cap: { early: 0.2, late: 0.9 } },
      }),
    );
  });

  it("switches balanced routing and saves drain hours and rest days", async () => {
    const slot = render([account()], {
      "config.set": () => config({ routingStrategy: "balanced" }),
    });
    const balanced = await slot.findByRole("switch", {
      name: "Балансировка",
    });
    await waitFor(() =>
      expect((balanced as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(balanced);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { routingStrategy: "balanced" },
      }),
    );
    const drain = await slot.findByLabelText("Часы расхода резерва");
    await waitFor(() =>
      expect((drain as HTMLInputElement).disabled).toBe(false),
    );
    fireEvent.change(drain, { target: { value: "12" } });
    fireEvent.blur(drain);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { reserveDrainHours: 12 },
      }),
    );
    expect(slot.getByText("вс, сб не идут в счёт до сброса.")).toBeTruthy();
    const friday = slot.getByRole("button", { name: "пт" });
    await waitFor(() =>
      expect((friday as HTMLButtonElement).disabled).toBe(false),
    );
    fireEvent.click(friday);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { restDays: [0, 5, 6] },
      }),
    );
    fireEvent.click(slot.getByRole("button", { name: "вс" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { restDays: [6] },
      }),
    );
  });

  it("lists when each reserve account joins the primary ones", async () => {
    const soon = account({
      id: "22222222-2222-4222-8222-222222222222",
      label: "work-soon@example.com",
      email: "work-soon@example.com",
      role: "reserve",
      capLimit: 0.8,
      drainOpensAt: Date.now() - 60_000,
      sevenDayResetAt: Date.now() + 60 * 60 * 1_000,
    });
    const later = account({
      id: "33333333-3333-4333-8333-333333333333",
      label: "work-later@example.com",
      email: "work-later@example.com",
      role: "reserve",
      capLimit: 0.3,
      drainOpensAt: Date.now() + 2 * 24 * 60 * 60 * 1_000,
      sevenDayResetAt: Date.now() + 3 * 24 * 60 * 60 * 1_000,
    });
    const slot = render([account(), later, soon]);
    expect(await slot.findByText("Окна расхода")).toBeTruthy();
    expect(slot.getByText("уже открыто")).toBeTruthy();
    const table = slot.getByLabelText("Окна расхода Claude");
    expect(slot.queryByLabelText("Окна расхода Codex")).toBeNull();
    const rows = Array.from(table.querySelectorAll("tbody tr")).map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("work-soon@example.com");
    expect(rows[1]).toContain("work-later@example.com");
    expect(rows[1]).toContain("30%");
    expect(rows[1]).toMatch(/\d{2}\.\d{2} \d{2}:\d{2} \(/);
  });

  it("separates a capped account from a reserve account on standby", async () => {
    const capped = account({
      role: "reserve",
      cap: { early: 0.15, late: 0.98 },
      capLimit: 0.2,
      capReached: true,
      eligible: false,
      sevenDayUtilization: 0.5,
      sevenDayResetAt: Date.now() + 2 * 24 * 60 * 60 * 1_000,
    });
    const standby = account({
      id: "22222222-2222-4222-8222-222222222222",
      label: "standby@example.com",
      email: "standby@example.com",
      role: "reserve",
      capLimit: 0.6,
      eligible: false,
    });
    const slot = render([capped, standby]);
    expect(
      await slot.findByText((text) => text.startsWith("Потолок · ")),
    ).toBeTruthy();
    expect(slot.getByText("Резерв · в запасе")).toBeTruthy();
    expect(slot.getByText("50%").className).toContain("text-destructive-text");
  });

  it("names a Codex window without a reported length by its slot", async () => {
    const codex = account({
      provider: "codex",
      kind: "oauth",
      label: "codex@example.com",
      email: "codex@example.com",
      subscriptionType: "pro",
      fiveHourUtilization: null,
      limitWindows: [
        {
          slot: "secondary",
          windowMinutes: null,
          utilization: 0.12,
          resetAt: null,
          status: null,
          observedAt: 1,
          source: "header",
        },
      ],
    });
    const slot = render([codex]);
    expect(await slot.findByText("7Д")).toBeTruthy();
    expect(slot.queryByText("ЛИМИТ 2")).toBeNull();
    fireEvent.click(
      await slot.findByRole("button", { name: "Открыть codex@example.com" }),
    );
    expect(await slot.findByText("Неделя")).toBeTruthy();
    expect(slot.queryByText("Второй лимит")).toBeNull();
  });

  it("explains the role, the weekly cap, and the effective skip limit in the detail dialog", async () => {
    const work = account({
      successfulRequests: 12,
      role: "reserve",
      cap: { early: 0.15, late: 0.98 },
      capLimit: 0.45,
      sevenDayUtilization: 0.5,
      sevenDayResetAt: Date.now() + 3 * 24 * 60 * 60 * 1_000,
    });
    const slot = render([work]);
    fireEvent.click(
      await slot.findByRole("button", { name: "Открыть person@example.com" }),
    );
    fireEvent.click(slot.getByText(/Доступ и маршрут/, { selector: "summary" }));
    fireEvent.click(slot.getByText("Диагностика", { selector: "summary" }));
    expect(slot.getByText(/Резерв · приоритет/)).toBeTruthy();
    expect(slot.getByText("15% → 98% · сейчас 45%")).toBeTruthy();
    expect(slot.getByText("Запросы через пул")).toBeTruthy();
    expect(slot.getByText("12 успешных с момента начала учёта")).toBeTruthy();
    expect(slot.getAllByText((text) => text.includes("сброс") && text.includes("МСК"))).toBeTruthy();
    expect(
      slot.getByText(
        "Используется, только когда ни один основной аккаунт не подходит, или за 24 рабочих часов до его недельного сброса.",
      ),
    ).toBeTruthy();
    expect(
      within(slot.getByRole("region", { name: "person@example.com" })).getByText((text) => text.includes("потолок 45%") && text.includes("от потолка")),
    ).toBeTruthy();
  });

  it("shows saved Codex resets separately from automatic usage windows", async () => {
    const slot = render([account({
      provider: "codex",
      label: "codex@example.com",
      email: "codex@example.com",
      resetCredits: {
        availableCount: 2,
        credits: [
          { title: "Полный сброс", expiresAt: Date.parse("2030-10-05T20:17:35Z") },
          { title: "Полный сброс", expiresAt: Date.parse("2030-10-22T22:12:41Z") },
        ],
        observedAt: Date.now(),
      },
    })]);
    fireEvent.click(await slot.findByRole("button", { name: "Открыть codex@example.com" }));
    expect(slot.getByText("Сохранённые сбросы лимита использования")).toBeTruthy();
    fireEvent.click(slot.getByText(/Сохранённые сбросы лимита использования/, { selector: "summary" }));
    expect(slot.getAllByText(/Доступно: 2/)).toHaveLength(2);
    expect(slot.getByText(/действует до 5 октября 2030.*23:17:35 МСК/)).toBeTruthy();
    expect(slot.getByText(/действует до 23 октября 2030.*01:12:41 МСК/)).toBeTruthy();
  });

  it("shows Claude saved reset quantity, scope, deadline and usage restriction", async () => {
    const slot = render([account({
      resetCredits: {
        availableCount: 2, observedAt: Date.now(),
        credits: [{ title: "Сброс лимитов Claude", remaining: 2,
          expiresAt: Date.parse("2030-04-22T09:17:35Z"),
          limitTypes: ["five_hour", "seven_day"], usableNow: false, requiresLimit: true }],
      },
    })]);
    fireEvent.click(await slot.findByRole("button", { name: "Открыть person@example.com" }));
    fireEvent.click(slot.getByText(/Сохранённые сбросы лимита использования/, { selector: "summary" }));
    expect(slot.getAllByText(/Доступно: 2/)).toHaveLength(2);
    expect(slot.getByText("Сброс лимитов Claude · сбросов: 2")).toBeTruthy();
    expect(slot.getByText(/22 апреля 2030.*12:17:35 МСК/)).toBeTruthy();
    expect(slot.getByText("Обновляет: 5 часов, недельный лимит")).toBeTruthy();
    expect(slot.getByText("Можно использовать при достижении лимита")).toBeTruthy();
  });

  it("shows every observed family bucket in the detail dialog", async () => {
    const fable = {
      utilization: 0.91,
      resetAt: Date.now() + 3_600_000,
      status: null,
      observedAt: 1,
      source: "usage" as const,
    };
    const slot = render([
      account({
        familyWeekly: {
          fable,
          sonnet: null,
          opus: { ...fable, utilization: 0.2 },
          haiku: null,
          other: null,
        },
      }),
    ]);
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Открыть карточку: person@example.com",
      }),
    );
    expect(await slot.findByText("Fable, неделя")).toBeTruthy();
    expect(slot.getByText("Opus, неделя")).toBeTruthy();
  });

  it("shows only email in the row and detail dialog", async () => {
    const slot = render([
      account({ label: "Person Example", email: "person@example.com" }),
      account({
        id: "22222222-2222-4222-8222-222222222222",
        label: "Claude API key",
        email: null,
      }),
    ]);
    expect(await slot.findByRole("button", { name: "Открыть person@example.com" })).toBeTruthy();
    expect(slot.queryByText("Person Example")).toBeNull();
    expect(slot.getAllByText("person@example.com")).toHaveLength(1);
    fireEvent.click(
      slot.getByRole("button", { name: "Открыть карточку: person@example.com" }),
    );
    fireEvent.click(slot.getByText("Диагностика", { selector: "summary" }));
    expect(await slot.findByText("Почта")).toBeTruthy();
    expect(slot.getAllByText("person@example.com")).toHaveLength(3);
  });

  function codexLoginStart() {
    return {
      sessionId: "33333333-3333-4333-8333-333333333333",
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: Date.now() + 600_000,
      intervalMs: 60_000,
    };
  }

  function mockCompactViewport(matches: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)" && matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  it("names the sign-in dialog once and keeps the step instructions", async () => {
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(await slot.findByRole("button", { name: "Войти в Codex" }));
    const dialog = await slot.findByRole("dialog", {
      name: "Вход в Codex",
    });
    expect(slot.getAllByRole("heading", { name: "Вход в Codex" })).toHaveLength(
      1,
    );
    expect(dialog.textContent).toContain(
      "Откройте страницу проверки, войдите в ChatGPT и введите этот код.",
    );
    expect(
      (await slot.findByLabelText("Код устройства Codex")).textContent,
    ).toContain("ABCD-1234");
    expect(slot.queryByRole("button", { name: "Отмена" })).toBeNull();
  });

  it.each([false, true])(
    "cancels the pending sign-in from the header close with compact viewport %s",
    async (compact) => {
      mockCompactViewport(compact);
      const slot = render([], {
        "codexLogin.start": codexLoginStart,
        "codexLogin.poll": () => ({ status: "pending" }),
        "codexLogin.cancel": () => ({ cancelled: true }),
      });
      fireEvent.click(
        await slot.findByRole("button", { name: "Войти в Codex" }),
      );
      await slot.findByRole("dialog", { name: "Вход в Codex" });
      fireEvent.click(slot.getByRole("button", { name: "Закрыть" }));
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "codexLogin.cancel",
          input: { sessionId: codexLoginStart().sessionId },
        }),
      );
      await waitFor(() =>
        expect(slot.queryByRole("dialog", { name: "Вход в Codex" })).toBe(null),
      );
      const polls = () =>
        slot.rpcCalls.filter((call) => call.method === "codexLogin.poll")
          .length;
      const settled = polls();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(polls()).toBe(settled);
    },
  );

  it("copies the exact device code and distinguishes it from the URL copy", async () => {
    const codeWrite = deferred<void>();
    const writeText = vi.fn().mockImplementationOnce(() => codeWrite.promise).mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], { "codexLogin.start": codexLoginStart });
    const loginButton = await slot.findByRole("button", { name: "Войти в Codex" });
    await act(async () => {
      fireEvent.click(loginButton);
    });
    const codeCopyButton = await slot.findByRole("button", {
      name: "Скопировать код входа Codex",
    });
    // Control only the success indicator. Switching the entire mounted Radix
    // dialog to fake timers can race its existing real timers on busy workers.
    const schedule = globalThis.setTimeout;
    let expire: (() => void) | undefined;
    let expirationTimer: ReturnType<typeof setTimeout> | undefined;
    const timerSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((...[callback, delay, ...args]: Parameters<typeof setTimeout>) => {
      if (delay !== 1500 || typeof callback !== "function") return schedule(callback, delay, ...args);
      expect(expire).toBeUndefined();
      expire = () => callback(...args);
      expirationTimer = schedule(() => {}, 60_000);
      return expirationTimer;
    }) as typeof setTimeout);
    try {
      fireEvent.click(codeCopyButton);
      expect(writeText).toHaveBeenCalledWith("ABCD-1234");
      await act(async () => {
        codeWrite.resolve(undefined);
        await codeWrite.promise;
      });
      expect(await slot.findByText("Код входа скопирован")).toBeTruthy();
      expect(codeCopyButton.querySelector('[data-icon="Check"]')).not.toBeNull();
      expect(expire).toBeTypeOf("function");
      clearTimeout(expirationTimer);
      act(() => expire!());
      expect(slot.queryByText("Код входа скопирован")).toBeNull();
      expect(codeCopyButton.querySelector('[data-icon="Check"]')).toBeNull();
      timerSpy.mockRestore();

      await act(async () => {
        fireEvent.click(slot.getByRole("button", { name: "Скопировать ссылку авторизации Codex" }));
        await writeText.mock.results[1]?.value;
      });
      expect(writeText).toHaveBeenCalledWith("https://auth.openai.com/codex/device");
    } finally {
      clearTimeout(expirationTimer);
      timerSpy.mockRestore();
    }
  });

  it("does not claim success when copying the device code fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(await slot.findByRole("button", { name: "Войти в Codex" }));
    const button = await slot.findByRole("button", {
      name: "Скопировать код входа Codex",
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(window.getSelection()?.toString()).toBe("ABCD-1234"),
    );
    expect(slot.queryByText("Код входа скопирован")).toBeNull();
    expect(button.querySelector('[data-icon="Check"]')).toBeNull();
  });

  it("does not claim success when copying the authorization URL fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(await slot.findByRole("button", { name: "Войти в Codex" }));
    const button = await slot.findByRole("button", {
      name: "Скопировать ссылку авторизации Codex",
    });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(button.textContent).not.toContain("Скопировано");
    expect(slot.queryByText("Ссылка авторизации скопирована")).toBeNull();
  });

  it("keeps polling and the close action working after copying the code", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], {
      "codexLogin.start": codexLoginStart,
      "codexLogin.poll": () => ({ status: "pending" }),
      "codexLogin.cancel": () => ({ cancelled: true }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Войти в Codex" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Скопировать код входа Codex" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-1234"));
    expect(
      (await slot.findByRole("dialog", { name: "Вход в Codex" })).textContent,
    ).toContain("Жду авторизацию");
    fireEvent.click(slot.getByRole("button", { name: "Закрыть" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "codexLogin.cancel",
        input: { sessionId: codexLoginStart().sessionId },
      }),
    );
  });

  it("offers a fresh Codex login after device-code polling fails", async () => {
    vi.useFakeTimers();
    try {
      const first = codexLoginStart();
      const second = {
        ...first,
        sessionId: "44444444-4444-4444-8444-444444444444",
        userCode: "EFGH-5678",
      };
      const start = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
      const poll = vi.fn(() => ({ status: "error", message: "Code expired." }));
      let slot!: ReturnType<typeof render>;
      await act(async () => {
        slot = render([], {
          "codexLogin.start": start,
          "codexLogin.poll": poll,
        });
      });

      await act(async () => {
        fireEvent.click(slot.getByRole("button", { name: "Войти в Codex" }));
      });
      const dialog = within(slot.getByRole("dialog", { name: "Вход в Codex" }));
      expect(dialog.getByLabelText("Код устройства Codex").textContent).toContain(first.userCode);
      expect(poll).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(first.intervalMs);
      });
      expect(poll).toHaveBeenCalledTimes(1);
      expect(slot.rpcCalls).toContainEqual({
        method: "codexLogin.poll",
        input: { sessionId: first.sessionId },
      });
      expect(dialog.getByText("Code expired.")).toBeTruthy();

      await act(async () => {
        fireEvent.click(dialog.getByRole("button", { name: "Попробовать снова" }));
      });
      expect(start).toHaveBeenCalledTimes(2);
      expect(dialog.getByLabelText("Код устройства Codex").textContent).toContain(second.userCode);
      expect(dialog.queryByText("Code expired.")).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });
  it.each(["claude", "codex"] as const)(
    "reorders %s accounts with the keyboard and persists the displayed order",
    async (provider) => {
      measureAccountRows();
      const first = account({ label: "First", email: "first@example.com", provider });
      const second = account({
        id: "22222222-2222-4222-8222-222222222222",
        label: "Second",
        email: "second@example.com",
        provider,
      });
      const other = account({
        id: "33333333-3333-4333-8333-333333333333",
        provider: provider === "claude" ? "codex" : "claude",
        label: "Other",
        email: "other@example.com",
      });
      const accounts = [first, second, other];
      let finishSave = () => {};
      const slot = render(accounts, {
        "account.reorder": () =>
          new Promise<null>((resolve) => {
            finishSave = () => {
              accounts.splice(0, 2, second, first);
              resolve(null);
            };
          }),
      });
      const handle = await slot.findByRole("button", {
        name: "Переместить first@example.com",
      });
      await keyboardMove(handle);
      fireEvent.keyDown(document, { code: "Space" });
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "account.reorder",
          input: { provider, accountIds: [second.id, first.id] },
        }),
      );
      const providerOrder = () =>
        slot
          .getAllByRole("button", { name: /Переместить (first|second)@example\.com/ })
          .map((button) => button.getAttribute("aria-label"));
      expect(providerOrder()).toEqual([
        "Переместить second@example.com",
        "Переместить first@example.com",
      ]);
      expect(handle.hasAttribute("disabled")).toBe(true);
      finishSave();
      await waitFor(() => expect(handle.hasAttribute("disabled")).toBe(false));
      expect(providerOrder()).toEqual([
        "Переместить second@example.com",
        "Переместить first@example.com",
      ]);
      expect(
        slot
          .getByRole("button", { name: "Переместить other@example.com" })
          .hasAttribute("disabled"),
      ).toBe(true);
    },
  );

  it("restores the displayed order and reports a rejected reorder", async () => {
    measureAccountRows();
    const slot = render(
      [
        account({ label: "First", email: "first@example.com" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
          email: "second@example.com",
        }),
      ],
      {
        "account.reorder": () => {
          throw new Error("Refresh the account list and try again.");
        },
      },
    );
    const handle = await slot.findByRole("button", {
      name: "Переместить first@example.com",
    });
    await keyboardMove(handle);
    fireEvent.keyDown(document, { code: "Space" });
    expect(
      await slot.findByText("Refresh the account list and try again."),
    ).toBeTruthy();
    expect(
      slot
        .getAllByRole("button", { name: /Переместить/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Переместить first@example.com", "Переместить second@example.com"]);
    expect(handle.hasAttribute("disabled")).toBe(false);
  });

  it.each(["cancel", "unchanged"])(
    "does not save a %s drag",
    async (action) => {
      measureAccountRows();
      const slot = render([
        account({ label: "First", email: "first@example.com" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
          email: "second@example.com",
        }),
      ]);
      const handle = await slot.findByRole("button", {
        name: "Переместить first@example.com",
      });
      await keyboardMove(handle, action === "cancel" ? "ArrowDown" : "ArrowUp");
      fireEvent.keyDown(document, {
        code: action === "cancel" ? "Escape" : "Space",
      });
      await waitFor(() =>
        expect(handle.getAttribute("aria-pressed")).toBeNull(),
      );
      expect(
        slot.rpcCalls.filter((call) => call.method === "account.reorder"),
      ).toEqual([]);
      expect(
        slot
          .getAllByRole("button", { name: /Переместить/ })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Переместить first@example.com", "Переместить second@example.com"]);
    },
  );
});


describe("thread subscription indicator", () => {
  it("hides the federation refusal and stops polling the remote thread", async () => {
    vi.useFakeTimers();
    try {
      const ui = renderSlot(app.threadHeaderActions[0]!, {
        threadId: "thr_remote", projectId: "proj_remote", isCompactViewport: true,
      }, {
        rpc: { "thread.account": async () => {
          throw Object.assign(new Error("Plugin RPC is outside federation scope"), {
            serverCode: "federation_plugin_not_federated", status: 409,
          });
        } },
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(ui.queryByRole("button", { name: /Подписка треда/ })).toBeNull();
      expect(ui.rpcCalls).toEqual([{ method: "thread.account", input: { threadId: "thr_remote" } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps showing unrelated pool check errors", async () => {
    const ui = renderSlot(app.threadHeaderActions[0]!, {
      threadId: "thr_local", projectId: "proj_local", isCompactViewport: false,
    }, {
      rpc: { "thread.account": () => {
        throw Object.assign(new Error("Pool unavailable"), { status: 409 });
      } },
    });
    expect(await ui.findByRole("button", { name: /Пул: ошибка проверки/ })).toBeTruthy();
  });

  it("shows the confirmed account and availability, with details on click", async () => {
    const ui = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr-test", projectId: "project", isCompactViewport: false }, {
      rpc: { "thread.account": () => ({ state: "observed", account: account({ eligible: false }), lastUsedAt: 1800000000000 }) },
    });
    const button = await ui.findByRole("button", { name: /Подписка треда: person@example.com · сейчас недоступен/ });
    fireEvent.click(button);
    expect(await ui.findByText(/Последний подтверждённый запрос/)).toBeTruthy();
  });
  it("does not claim an account before observing a request", async () => {
    const ui = renderSlot(app.threadHeaderActions[0]!, { threadId: "thr-test", projectId: "project", isCompactViewport: false }, {
      rpc: { "thread.account": () => ({ state: "unobserved", account: null, lastUsedAt: null }) },
    });
    expect(await ui.findByText("Пул: ещё нет данных")).toBeTruthy();
  });
});
it('does not label an armed draining account as outside its closed schedule',async()=>{
 const slot=render([account({drainOnce:true,policy:{enabled:true,fiveHourKeep:null,weeklyKeep:null,reserveDrainHours:null,schedule:{timeZone:'UTC',intervals:[]}}})]);
 await slot.findByText('person@example.com');
 expect(slot.queryByText('Вне расписания')).toBeNull();
});

it('enables fail-closed VPN Guard linkage through the existing autosave config RPC',async()=>{
  const slot=render([],{'config.set':()=>config({vpnGuardEnabled:true})});
  const checkbox=await slot.findByRole('checkbox',{name:'Подчиняться VPN Guard'});
  expect(slot.queryByText(/Старый \/1/)).toBeNull();
  fireEvent.click(checkbox);
  await waitFor(()=>expect(slot.rpcCalls).toContainEqual(expect.objectContaining({method:'config.set',input:{vpnGuardEnabled:true}})));
  slot.unmount();
});

it.each(['kimi','zai','opencode-go','cursor','devin'] as const)('shows the observed %s email in the thread header',async provider=>{
 const ui=renderSlot(app.threadHeaderActions[0]!,{threadId:'thread-one',projectId:'project',isCompactViewport:false},{rpc:{'thread.account':()=>({state:'observed',account:account({provider,kind:'api-key',email:'other@example.com',label:'Subscription'}),lastUsedAt:1800000000000})}});
 expect(await ui.findByRole('button',{name:/Подписка треда: other@example.com/})).toBeTruthy();
});

it('keeps a saved account awaiting login with a dedicated sign-in action',async()=>{
 const a=account({draft:true,enabled:false,status:'disabled',label:'Prepared subscription'});
 const slot=render([a],{'login.reauthorize':()=>({sessionId:'fixture-session',authorizeUrl:'https://login.example/authorize'})});
 await waitFor(()=>expect(slot.getByText('Ожидает входа')).toBeTruthy());
 fireEvent.click(await slot.findByRole('button',{name:'Открыть карточку: person@example.com'}));
 fireEvent.click(await slot.findByRole('button',{name:'Войти в аккаунт'}));
 await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'login.reauthorize',input:{accountId:a.id}}));
 expect(slot.rpcCalls.some(c=>c.method==='account.enable')).toBe(false);
});

it.each([false,true])('switches subscription inside the existing dialog; RPC error=%s',async fails=>{
 const id='11111111-1111-4111-8111-111111111111';
 const choices={currentAccountId:null,mode:'auto',pinned:false,accounts:[{id,label:'person@example.test',state:'ready',until:null,selectable:true,assigned:true}]};
 const ui=renderSlot(app.threadHeaderActions[0]!,{threadId:'thr-test',projectId:'project',isCompactViewport:true},{
  rpc:{'thread.account':()=>({state:'unobserved',account:null,lastUsedAt:null}),
   'thread.accountChoices':()=>choices,
   'thread.switchAccount':(input:any)=>{if(fails)throw Error('synthetic');return {...choices,currentAccountId:input.accountId,mode:input.accountId?'manual':'auto',pinned:!!input.accountId};}}
 });
 fireEvent.click(await ui.findByRole('button',{name:/Подписка треда/}));
 fireEvent.click(await ui.findByRole('button',{name:/person@example.test/}));
 if(fails){expect(await ui.findByRole('alert')).toBeTruthy();expect(ui.getByRole('button',{name:'Автоматически (по умолчанию)'}).getAttribute('aria-pressed')).toBe('true');}
 else{
  await waitFor(()=>expect(ui.getByRole('button',{name:/person@example.test/}).getAttribute('aria-pressed')).toBe('true'));
  expect(ui.rpcCalls).toContainEqual({method:'thread.switchAccount',input:{threadId:'thr-test',accountId:id}});
  fireEvent.click(ui.getByRole('button',{name:'Автоматически (по умолчанию)'}));
  await waitFor(()=>expect(ui.getByRole('button',{name:'Автоматически (по умолчанию)'}).getAttribute('aria-pressed')).toBe('true'));
 }
});

it.each(['ready','disabled'] as const)('uses thread choice state %s for confirmed reserve account',async state=>{
 const a=account({email:'person@example.test',role:'reserve',eligible:false});
 const choices={currentAccountId:a.id,mode:'auto',pinned:false,accounts:[{id:a.id,label:'person@example.test',state,until:null,selectable:state==='ready',assigned:false}]};
 const ui=renderSlot(app.threadHeaderActions[0]!,{threadId:'thr-test',projectId:'project',isCompactViewport:false},{
  rpc:{'thread.account':()=>({state:'observed',account:a,lastUsedAt:1800000000000}),'thread.accountChoices':()=>choices}
 });
 fireEvent.click(await ui.findByRole('button',{name:/Подписка треда: person@example.test · сейчас недоступен/}));
 const expected=state==='ready'?'готов':'выключен';
 await waitFor(()=>expect(ui.getByRole('button',{name:'Подписка треда: person@example.test · '+expected,hidden:true})).toBeTruthy());
 expect(ui.getByText(/Последний подтверждённый запрос/).textContent).toContain('person@example.test · '+expected);
});

it("opens machine tokens independently and keeps the existing rotation action", async () => {
  const rotate = vi.fn(() => ({ token: "synthetic-unshown-value" }));
  const slot = render(undefined, { "token.rotate": rotate });
  const trigger = await slot.findByRole("button", { name: "Токены машин" });
  const advanced = slot.getByRole("button", { name: "Дополнительно" });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByRole("button", { name: "Обновить bee" })).toBeNull();

  fireEvent.click(trigger);
  expect(advanced.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(await slot.findByRole("button", { name: "Обновить bee" }));
  await waitFor(() => expect(rotate).toHaveBeenCalledWith({ machine: "host-one" }));
  expect(slot.queryByText("synthetic-unshown-value")).toBeNull();

  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(slot.queryByRole("button", { name: "Обновить bee" })).toBeNull();
});
