// @vitest-environment jsdom
import { ThreadAccountOverlay } from "./app";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { version } from "./package.json";
import type {
  AccountPoolConfig,
  AccountSummary,
  PoolStatus,
} from "./src/contracts.js";

vi.mock('./management-ui', async () => {
  const { useRpc } = await import('@get-bb/plugin-sdk/app');
  return {
    ManagementGate: ({ children }: { children: unknown }) => children,
    usePoolRpc: () => {
      const rpc = useRpc();
      return { call: async (method: string, input: unknown) => {
        if (method.startsWith('update.')) throw new Error('Management access is locked.');
        return rpc.call(method, input);
      } };
    },
    useManagementGrant: () => ({ scope: 'manage', expiresAt: Date.now() + 60_000 }),
  };
});

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
    neuraldeep: null, nvidia: null, ifm: null, agy: null,
    cursor: null,
    devin: null,
    grok: null,
    gemini: null,
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
    neuraldeep: true, nvidia: true, ifm: true, agy: true,
      cursor: true,
      devin: true,
      grok: true,
      gemini: true,
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

    maxConcurrentRequestsPerAccount: 2,
    claudeRequestStartIntervalMs: 0,
    grokUpstreamBaseUrl: "https://api.x.ai/v1",
    geminiUpstreamBaseUrl: "https://generativelanguage.googleapis.com",
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

describe("Account Pool settings", () => {
  it("shows the Pooler version beside the update controls", async () => {
    const slot = render();
    const panel = slot.getByRole("region", { name: "Pooler update" });
    expect(within(panel).getByText(`Pooler version ${version}`)).toBeTruthy();
    expect(await within(panel).findByRole("button", { name: "Update Pooler" })).toBeTruthy();
  });

  it("puts hub status at the bottom inside collapsed technical details", async () => {
    const slot = render();
    const hubStatus = await slot.findByText("Hub accepting requests · 2 in flight · used by bee");
    const details = hubStatus.closest("details");
    expect(details?.open).toBe(false);
    const content = Array.from(details?.parentElement?.children ?? []).filter((element) => element.tagName !== "STYLE");
    expect(content.at(-1)).toBe(details);
    fireEvent.click(slot.getByText("Technical details"));
    expect(details?.open).toBe(true);
  });

  it('starts the server updater from the pool interface and blocks repeated clicks',async()=>{
    const operation={operationId:'11111111-1111-4111-8111-111111111111',hostId:'host-one',terminalId:'terminal-one',startedAt:1,state:'running'};
    const start=vi.fn(async()=>operation);
    const slot=render([],{"update.start":start,"update.status":()=>start.mock.calls.length?operation:null});
    const button=await slot.findByRole('button',{name:"Update Pooler"});
    fireEvent.click(button);
    await slot.findByText("Preparation and update are running. Work will resume automatically.");
    expect(slot.getByRole('button',{name:"Checking update…"}).hasAttribute('disabled')).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(slot.getByText(/Pauses sessions and autopilot requests/)).toBeTruthy();
  });
  it("explains when the installed Pooler release is already current", async () => {
    const operation = {
      operationId: "11111111-1111-4111-8111-111111111111",
      hostId: "host-one", terminalId: "terminal-one", startedAt: 1,
      state: "succeeded", alreadyCurrent: true,
    };
    const start = vi.fn(async () => operation);
    const slot = render([], {"update.start": start, "update.status": () => start.mock.calls.length ? operation : null});
    fireEvent.click(await slot.findByRole("button", {name: "Update Pooler"}));
    expect((await slot.findByText("The latest version is already installed.")).getAttribute("role")).toBe("status");
  });

  it('recovers update progress after reopening the interface',async()=>{
    const slot=render([],{"update.status":()=>({operationId:'11111111-1111-4111-8111-111111111111',hostId:'host-one',terminalId:'terminal-one',startedAt:1,state:'running'})});
    await slot.findByText("Preparation and update are running. Work will resume automatically.");
    expect(slot.getByRole('button',{name:"Checking update…"}).hasAttribute('disabled')).toBe(true);
  });
  it('shows status errors and disables starting until the server confirms the update state',async()=>{
    const start=vi.fn(async()=>null);
    const read=vi.fn(async()=>{throw new Error('Connection unavailable');});
    const slot=render([],{"update.status":read,"update.start":start});
    const message=await slot.findByText("Could not check update status. Starting is unavailable for now.");
    expect(message.getAttribute('role')).toBe('alert');
    expect(slot.getByRole('button',{name:"Update Pooler"}).hasAttribute('disabled')).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });

  it('opens the native card and saves the existing all-projects control',async()=>{
    const projects={onlySelected:true,rules:[{projectId:'project-one',role:'inherit' as const}]};
    const slot=render([],{"native.accounts":()=>({managed:true,selectionRevision:'b'.repeat(64),accounts:[{accountId:'subscription-one',projects,projectsRevision:'a'.repeat(64),mixedProjects:false,executors:[],active:0,queued:0,uncertain:0}]}),"native.updateAccount":()=>null});
    fireEvent.click(await slot.findByRole('button',{name:'Open Google account'}));
    const control=await slot.findByLabelText('Use in');
    expect(control.closest('.pool-settings')).not.toBeNull();
    expect((control as HTMLSelectElement).value).toBe('selected');
    expect(await slot.findByLabelText('Role in project-one')).toBeTruthy();
    fireEvent.change(control,{target:{value:'all'}});
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-one',projects:{...projects,onlySelected:false},expectedRevision:'b'.repeat(64)}}));
  });

  it('opens explicit settings and saves priority through the revision-bound action',async()=>{
    const slot=render([],{"native.accounts":()=>({managed:true,selectionRevision:'b'.repeat(64),accounts:[{
      accountId:'subscription-two',label:'Second Google',projects:{onlySelected:false,rules:[]},projectsRevision:'a'.repeat(64),mixedProjects:false,
      executors:[{id:'second-host',enabled:true,autopilotAllowed:false}],active:0,queued:0,uncertain:0,
    }]}),"native.updateAccount":()=>null});
    expect(await slot.findByRole('button',{name:'Open Second Google'})).toBeTruthy();
    expect(slot.queryByRole('button',{name:'Use'})).toBeNull();
    fireEvent.pointerDown(slot.getByRole('button',{name:'Actions: Second Google'}));
    fireEvent.click(await slot.findByText("Configure"));
    const priority=await slot.findByLabelText('Account priority');
    fireEvent.change(priority,{target:{value:'2'}});fireEvent.blur(priority);
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',priority:2,expectedRevision:'b'.repeat(64)}}));
    const concurrency=await slot.findByLabelText('Concurrent sessions') as HTMLSelectElement;
    await waitFor(()=>expect(concurrency.disabled).toBe(false));
    expect(concurrency.value).toBe('1');
    fireEvent.change(concurrency,{target:{value:'2'}});
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',maxConcurrentSessions:2,expectedRevision:'b'.repeat(64)}}));
  });

  it('saves native role, project role and automation switches in the same account settings without legacy preference calls',async()=>{
    const item={accountId:'subscription-two',label:'Second Google',role:'primary',priority:1,projects:{onlySelected:false,rules:[{projectId:'project-one',role:'inherit'}]},projectsRevision:'a'.repeat(64),mixedProjects:false,executors:[{id:'second-host',enabled:true,autopilotAllowed:false}],active:0,queued:0,uncertain:0};
    const slot=render([],{"native.accounts":()=>({managed:true,selectionRevision:'b'.repeat(64),accounts:[item]}),"native.updateAccount":()=>null});
    fireEvent.click(await slot.findByRole('button',{name:'Open account card: Second Google'}));
    fireEvent.change(await slot.findByLabelText('Default role'),{target:{value:'reserve'}});
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',expectedRevision:'b'.repeat(64),role:'reserve'}}));
    await waitFor(()=>expect(slot.getByLabelText('Allow autopilot for second-host').closest('fieldset')?.disabled).toBe(false));
    fireEvent.click(slot.getByLabelText('Allow autopilot for second-host'));
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',expectedRevision:'b'.repeat(64),executor:{id:'second-host',autopilotAllowed:true}}}));
    await waitFor(()=>expect(slot.getByLabelText('Role in project-one').closest('fieldset')?.disabled).toBe(false));
    fireEvent.change(slot.getByLabelText('Role in project-one'),{target:{value:'primary'}});
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'native.updateAccount',input:{accountId:'subscription-two',expectedRevision:'b'.repeat(64),projects:{onlySelected:false,rules:[{projectId:'project-one',role:'primary'}]}}}));
    expect(slot.rpcCalls.some(call=>call.method==='native.prefer')).toBe(false);
  });
  it('shows a useful error when native settings conflict instead of claiming a saved priority',async()=>{
    const slot=render([],{"native.accounts":()=>({managed:true,selectionRevision:'b'.repeat(64),accounts:[{accountId:'subscription-two',label:'Second Google',role:'primary',priority:1,projects:{onlySelected:false,rules:[]},projectsRevision:'a'.repeat(64),mixedProjects:false,executors:[],active:0,queued:0,uncertain:0}]}),"native.updateAccount":()=>{throw Error('native-selection-changed');}});
    fireEvent.click(await slot.findByRole('button',{name:'Open Second Google'}));
    fireEvent.change(slot.getByLabelText('Default role'),{target:{value:'reserve'}});
    await slot.findByText("Settings changed in another session. Refresh and try again.");
  });

  it("shows one official Google subscription across executors without an OAuth sign-in", async () => {
    const slot = render([], {"native.accounts": () => ({managed: true, accounts: [{accountId: "subscription-one", executors: [
      {id: "official-desktop", enabled: true, autopilotAllowed: false},
      {id: "official-worker", enabled: true, autopilotAllowed: true},
    ], active: 1, queued: 2, uncertain: 0, maxConcurrentSessions: 2}]})});
    const row = await slot.findByRole("button", { name: "Open Google account" });
    expect(within(row).getByText("Enabled")).toBeTruthy();
    expect(within(row).getByText("Queued: 2")).toBeTruthy();
    expect(within(within(row).getByTitle("Active sessions / limit")).getByText("1 / 2")).toBeTruthy();
    expect(within(row).queryByText("5H")).toBeNull();
    fireEvent.click(slot.getByText("Selected accounts", { selector: "summary" }));
    const overview = await slot.findByRole("region", { name: "Selected accounts" });
    expect(within(overview).getByText("Selected for the session")).toBeTruthy();
    expect(slot.queryByText("No accounts yet")).toBeNull();
    expect(slot.getByRole("switch", {name: "Route Antigravity threads"})).toBeTruthy();
    expect(slot.queryByRole("button", {name: "Add Antigravity account"})).toBeNull();
    expect(slot.rpcCalls.some(call => call.method.startsWith("agyLogin."))).toBe(false);
  });
  it("keeps managed routing available when the route was previously disabled", async () => {
    const slot=render([], {
      "native.accounts":()=>({managed:true,accounts:[]}),
      "status.get":()=>({...status([]),routing:{...status([]).routing,agy:false}}),
      "routing.set":()=>null,
    });
    await slot.findByText("Official client");
    const toggle=slot.getByRole("switch",{name:"Route Antigravity threads"});
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:"routing.set",input:{provider:"agy",enabled:true}}));
  });
  it("surfaces native registry failures without offering an OAuth retry", async () => {
    const slot=render([], {"native.accounts":()=>{throw Error("registry unavailable");}});
    await slot.findByText("Could not load executors: registry unavailable");
    expect(slot.getByRole("switch", {name:"Route Antigravity threads"})).toBeTruthy();
    expect(slot.rpcCalls.some(call=>call.method.startsWith("agyLogin."))).toBe(false);
  });
  it("shows the executor, kind, age and operator command for an uncertain lease", async () => {
    const leaseId = "11111111-1111-4111-8111-111111111111";
    const slot = render([], {"status.get": () => ({
      ...status([]),
      uncertainNativeLeases: [{leaseId, executorId:"example-executor", kind:"catalog", ageMs:125_000}],
    })});
    expect(await slot.findByText("example-executor · catalog · 2 min")).toBeTruthy();
    expect(slot.getByText(`bb pool native attest-stopped ${leaseId} --confirmed`)).toBeTruthy();
  });

  it("marks uncertain execution and does not present it as ready", async () => {
    const slot = render([], {"native.accounts": () => ({managed: true, accounts: [{accountId: "subscription-one", executors: [
      {id: "official-desktop", enabled: true, autopilotAllowed: false},
    ], active: 0, queued: 0, uncertain: 1}]})});
    const row = await slot.findByRole("button", {name: "Open Google account"});
    expect(within(row).getByText("Stop unconfirmed: 1")).toBeTruthy();
    expect(within(row).queryByText("Enabled")).toBeNull();
  });

  it("saves the explicit account permission with compare-and-set and reports conflicts", async () => {
    const slot=render([account()], {"account.setAutopilotAllowed":()=>{throw Error("permission changed");}});
    fireEvent.click(await slot.findByRole("button", {name:"Open account card: person@example.com"}));
    fireEvent.click(slot.getByText(/Access and route/, { selector: "summary" }));
    const checkbox=slot.getByRole("checkbox",{name:"Allow autopilot"}) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    fireEvent.click(checkbox);
    await slot.findByText("Could not save autopilot permission. Refresh the data and try again.");
    expect(slot.rpcCalls).toContainEqual({method:"account.setAutopilotAllowed",input:{accountId:account().id,allowed:true,expectedAllowed:false}});
    expect(checkbox.checked).toBe(false);
  });

  it("opens the selected account browser from its menu", async () => {
    const selected = account();
    const slot = render([selected], { "browser.open": () => ({ opened: true }) });
    fireEvent.pointerDown(await slot.findByRole("button", { name: "Actions: person@example.com" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Open in browser" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "browser.open", input: { accountId: selected.id } }));
    await slot.findByText("Browser opened on the Pooler machine.");
  });

  it("opens a pasted authorization link in the selected profile without adding an account", async () => {
    const selected = account();
    const response = deferred<object>();
    const slot = render([selected], { "browser.open": () => response.promise });
    fireEvent.click(await slot.findByRole("button", { name: "Open person@example.com" }));
    fireEvent.click(slot.getByText("Account and actions", { selector: "summary" }));
    const dialog = within(slot.getByRole("region", { name: "person@example.com" }));
    expect(dialog.queryByRole("textbox", { name: "URL to open" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Open another URL" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "URL to open" }), { target: { value: "https://login.example/authorize?state=synthetic" } });
    fireEvent.click(dialog.getByRole("button", { name: "Open URL" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "browser.open", input: { accountId: selected.id, url: "https://login.example/authorize?state=synthetic" } }));
    expect(dialog.getByRole("button", { name: "Opening…" }).hasAttribute("disabled")).toBe(true);
    await act(async () => response.resolve({ opened: true }));
    await dialog.findByText("Browser opened on the Pooler machine.");
    expect(slot.rpcCalls.some(call => call.method === "account.add")).toBe(false);
  });

  it("keeps browser errors in the card and permits retry without losing the link", async () => {
    let attempts = 0;
    const slot = render([account()], { "browser.open": () => { if (++attempts === 1) throw new Error("VPN confirmation unavailable"); return { opened: true }; } });
    fireEvent.click(await slot.findByRole("button", { name: "Open person@example.com" }));
    fireEvent.click(slot.getByText("Account and actions", { selector: "summary" }));
    const dialog = within(slot.getByRole("region", { name: "person@example.com" }));
    expect(dialog.queryByRole("textbox", { name: "URL to open" })).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Open another URL" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "URL to open" }), { target: { value: "https://login.example/" } });
    fireEvent.click(dialog.getByRole("button", { name: "Open URL" }));
    await dialog.findByText("VPN confirmation unavailable");
    expect((dialog.getByRole("textbox", { name: "URL to open" }) as HTMLInputElement).value).toBe("https://login.example/");
    fireEvent.click(dialog.getByRole("button", { name: "Open URL" }));
    await dialog.findByText("Browser opened on the Pooler machine.");
  });

  it("shows a new OAuth failure instead of a previous browser failure", async () => {
    const slot = render([account()], {
      "browser.open": () => { throw new Error("Synthetic browser VPN failure"); },
      "login.reauthorize": () => { throw new Error("Synthetic OAuth failure"); },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Open person@example.com" }));
    fireEvent.click(slot.getByText("Account and actions", { selector: "summary" }));
    fireEvent.click(within(slot.getByRole("region", { name: "person@example.com" })).getByRole("button", { name: "Open in browser" }));
    await within(slot.getByRole("region", { name: "person@example.com" })).findByText("Synthetic browser VPN failure");
    fireEvent.pointerDown(slot.getByRole("button", { name: "More account actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Reauthorize" }));
    await within(slot.getByRole("dialog")).findByText("Synthetic OAuth failure");
    expect(slot.queryByText("Synthetic browser VPN failure")).toBeNull();
  });

  it("opens the existing reauthorization URL in that account profile", async () => {
    const selected = account();
    const slot = render([selected], {
      "login.reauthorize": () => ({ sessionId: "fixture-session", authorizeUrl: "https://login.example/authorize?state=synthetic", expiresAt: Date.now() + 600000 }),
      "browser.open": () => ({ opened: true }),
    });
    fireEvent.click(await slot.findByRole("button", { name: "Open person@example.com" }));
    fireEvent.click(slot.getByText("Account and actions", { selector: "summary" }));
    fireEvent.pointerDown(slot.getByRole("button", { name: "More account actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Reauthorize" }));
    fireEvent.click(await slot.findByRole("button", { name: "Open in account profile" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "browser.open", input: { accountId: selected.id, url: "https://login.example/authorize?state=synthetic" } }));
  });
  it.each(['start','complete'])('shows a Claude reauthorization %s error and offers retry',async stage=>{
    const selected=account();
    const failure='Signed in to a different account';
    const slot=render([selected],{
      'login.reauthorize':()=>{if(stage==='start')throw new Error(failure);return {sessionId:'fixture-session',authorizeUrl:'https://login.example/authorize',expiresAt:Date.now()+600000};},
      'login.complete':()=>{throw new Error(failure);},
    });
    fireEvent.click(await slot.findByRole('button',{name:'Open person@example.com'}));
    fireEvent.click(slot.getByText("Account and actions", { selector: "summary" }));
    fireEvent.pointerDown(slot.getByRole("button", { name: "More account actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Reauthorize" }));
    if(stage==='complete'){
      fireEvent.change(await slot.findByRole('textbox',{name:'Claude authorization code'}),{target:{value:'code#state'}});
      fireEvent.click(slot.getByRole('button',{name:'Finish'}));
    }
    await within(slot.getByRole('dialog')).findByText(failure);
    expect(slot.getByRole('button',{name:'Try again'})).toBeTruthy();
  });
  it("reauthorizes the selected disabled account rather than adding another account", async () => {
    const selected=account({enabled:false,status:'disabled',error:'[OAUTH_REAUTH_REQUIRED] OAuth refresh failed with HTTP 400.'});
    const slot=render([selected],{'login.reauthorize':()=>({sessionId:'fixture-session',authorizeUrl:'https://login.example/authorize',expiresAt:Date.now()+600000})});
    fireEvent.click(await slot.findByRole('button',{name:'Open person@example.com'}));
    fireEvent.click(slot.getByText("Account and actions", { selector: "summary" }));
    fireEvent.pointerDown(slot.getByRole("button", { name: "More account actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Reauthorize" }));
    await slot.findByText('Reauthorize Claude');
    expect(slot.rpcCalls).toContainEqual({method:'login.reauthorize',input:{accountId:selected.id}});
    expect(slot.rpcCalls.some(call=>call.method==='login.start')).toBe(false);
    expect(slot.getByText(/Sign in to person@example.com/)).toBeTruthy();
  });
  it("keeps the account card open through debounce and in-flight policy save", async () => {
    const selected = account();
    const response = deferred<object>();
    const slot = render([selected], { "account.setPolicy": () => response.promise });
    fireEvent.click(await slot.findByRole("button", { name: "Open person@example.com" }));
    fireEvent.click(slot.getByText(/Access and route/, { selector: "summary" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Account-specific settings" }));
    fireEvent.click(slot.getByRole("button", { name: "Collapse" }));
    expect(slot.getByRole("region", { name: "person@example.com" })).toBeTruthy();
    fireEvent.keyDown(slot.getByRole("region", { name: "person@example.com" }), { key: "Escape" });
    expect(slot.getByRole("region", { name: "person@example.com" })).toBeTruthy();
    await waitFor(() => expect(slot.rpcCalls.some(call => call.method === "account.setPolicy")).toBe(true));
    fireEvent.click(slot.getByRole("button", { name: "Collapse" }));
    expect(slot.getByRole("region", { name: "person@example.com" })).toBeTruthy();
    await act(async () => { response.resolve({ account: selected }); });
    await slot.findByText("Settings saved");
    fireEvent.click(slot.getByRole("button", { name: "Collapse" }));
    await waitFor(() => expect(slot.queryByRole("region", { name: "person@example.com" })).toBeNull());
  });

  it("toggles one-shot draining in the account card", async () => {
    const selected = account({ drainOnce: false });
    const slot = render([selected], { "account.setDrainOnce": () => {
      selected.drainOnce = !selected.drainOnce;
      return { account: selected };
    } });
    fireEvent.click(await slot.findByRole("button", { name: "Open person@example.com" }));
    const checkbox = slot.getByRole("checkbox", { name: "Use until exhausted" });
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
    expect(slot.getAllByText("Loading…").length).toBeGreaterThan(0);
    expect(slot.queryByText("No accounts yet")).toBeNull();
    live.resolve(status([account({ fiveHourUtilization: 0.6 })]));
    expect(await slot.findByText("60%")).toBeTruthy();
    expect(slot.queryByText("refreshing quotas…")).toBeNull();
    expect(slot.queryByText(/· refreshing…$/)).toBeNull();
    const cached = JSON.parse(
      window.localStorage.getItem(STATUS_CACHE_KEY) ?? "null",
    ) as PoolStatus;
    expect(cached.accounts[0]?.fiveHourUtilization).toBe(0.21);
  });

  it("ignores a malformed status cache and shows the loading state", async () => {
    window.localStorage.setItem(STATUS_CACHE_KEY, '{"accounts":"nope"}');
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    const providerLoaders = slot.getAllByText("Loading…").filter(element => !element.closest("details"));
    expect(providerLoaders).toHaveLength(13);
    live.resolve(status());
    expect(await slot.findByText("person@example.com")).toBeTruthy();
  });

  it("marks a row as refreshing while its usage refresh is in flight", async () => {
    const refresh = deferred<{ account: null }>();
    const slot = render([account()], {
      "account.refreshUsage": () => refresh.promise,
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "Actions: person@example.com" }),
    );
    fireEvent.click(await slot.findByText("Refresh quotas"));
    expect(await slot.findByText("refreshing quotas…")).toBeTruthy();
    refresh.resolve({ account: null });
    await waitFor(() => expect(slot.queryByText("refreshing quotas…")).toBeNull());
  });

  it("shows an unknown shared quota and omits unreported family windows", async () => {
    const slot = render();
    expect(await slot.findByText("person@example.com")).toBeTruthy();
    expect(slot.getByText("5H")).toBeTruthy();
    expect(slot.getByText("7D")).toBeTruthy();
    expect(slot.queryByText("FABLE")).toBeNull();
    expect(slot.getByText("—")).toBeTruthy();
  });

  it("keeps the quota slots visible at mobile widths", async () => {
    const slot = render();
    const group = (await slot.findByText("5H")).parentElement?.parentElement;
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
    expect(slot.getByText("7D")).toBeTruthy();
    expect(slot.getByText("100%")).toBeTruthy();
    expect(slot.getByText("5H")).toBeTruthy();
    expect(slot.queryByText("FABLE")).toBeNull();
    expect(
      slot.getByText(text => text.startsWith(
        `Exhausted · reset ${new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Moscow" }).format(blockingResetAt)} UTC+3`,
      )),
    ).toBeTruthy();
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Open account card: pro@example.com",
      }),
    );
    expect(await slot.findByText("Weekly")).toBeTruthy();
    expect(slot.getByText("5 hours")).toBeTruthy();
    expect(slot.queryByText("7 days")).toBeNull();
  });

  it.each([
    {
      action: "Disable",
      method: "account.disable",
      input: { id: account().id },
    },
    {
      action: "Refresh quotas",
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
          name: "Actions: person@example.com",
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
      await slot.findByRole("button", { name: "Actions: person@example.com" }),
    );
    fireEvent.click(await slot.findByText("Delete"));
    expect(await slot.findByText("Delete person@example.com?")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "account.remove")).toBe(
      false,
    );
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
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
      name: "Add account",
    });
    fireEvent.pointerDown(addButtons[0]!);
    fireEvent.click(
      await slot.findByText("Sign in to Claude", { selector: "span.block" }),
    );
    expect(await slot.findByLabelText("Claude authorization code")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    fireEvent.pointerDown(addButtons[1]!);
    fireEvent.click(
      await slot.findByText("Sign in to Codex", { selector: "span.block" }),
    );
    expect(
      (await slot.findByLabelText("Codex device code")).textContent,
    ).toContain("ABCD-1234");
  });

  it("offers Antigravity Google login without paid key or local credential import",async()=>{
    const slot=render([],{'agyLogin.cancel':()=>({cancelled:true}),'agyLogin.start':()=>({sessionId:'synthetic-session',authorizeUrl:'https://accounts.google.com/o/oauth2/v2/auth',expiresAt:Date.now()+600000})});
    await slot.findByRole('switch',{name:'Route Antigravity threads'});
    const buttons=await slot.findAllByRole('button',{name:'Add account'});
    fireEvent.pointerDown(buttons[4]!);
    fireEvent.click(await slot.findByText('Sign in to Antigravity',{selector:'span.block'}));
    expect(await slot.findByLabelText('Google authorization code')).toBeTruthy();
    expect(slot.queryByText('Add API key…')).toBeNull();
    expect(slot.queryByText('Import from this machine')).toBeNull();
    fireEvent.click(slot.getByRole('button',{name:'Close'}));
    await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'agyLogin.cancel',input:{sessionId:'synthetic-session'}}));
  });

  it("offers Grok sign-in, import, and the API key last", async () => {
    const slot = render([], {
      "grokLogin.start": () => ({
        sessionId: "44444444-4444-4444-8444-444444444444",
        verificationUri: "https://auth.example/device",
        userCode: "WXYZ-5678",
        expiresAt: Date.now() + 600_000,
        intervalMs: 60_000,
      }),
      "grokLogin.poll": () => ({ status: "pending" }),
      "grokLogin.cancel": () => ({ cancelled: true }),
    });
    const addButtons = await slot.findAllByRole("button", { name: "Add account" });
    fireEvent.pointerDown(within(slot.getByRole("heading",{name:"Grok"}).closest("section")!).getByRole("button",{name:"Add account"}));
    expect(await slot.findByText("Sign in to Grok", { selector: "span.block" })).toBeTruthy();
    expect(slot.getByText("Import from this machine")).toBeTruthy();
    expect(slot.getByText("Add API key…")).toBeTruthy();
    expect(slot.getByText("Paid fallback, selected last")).toBeTruthy();
    fireEvent.click(slot.getByText("Sign in to Grok", { selector: "span.block" }));
    expect((await slot.findByLabelText("Grok device code")).textContent).toContain("WXYZ-5678");
    expect(slot.rpcCalls).toContainEqual({ method: "grokLogin.start", input: null });
  });

  it("offers Gemini sign-in and hides the code when Google does not provide one", async () => {
    const slot = render([], {
      "geminiLogin.start": () => ({
        sessionId: "55555555-5555-4555-8555-555555555555",
        verificationUri: null,
        userCode: null,
        expiresAt: Date.now() + 600_000,
        intervalMs: 60_000,
      }),
      "geminiLogin.poll": () => ({ status: "pending" }),
      "geminiLogin.cancel": () => ({ cancelled: true }),
    });
    const addButtons = await slot.findAllByRole("button", { name: "Add account" });
    fireEvent.pointerDown(within(slot.getByRole("heading",{name:"Gemini"}).closest("section")!).getByRole("button",{name:"Add account"}));
    expect(await slot.findByText("Sign in to Gemini", { selector: "span.block" })).toBeTruthy();
    expect(slot.getByText("Paid fallback, selected last")).toBeTruthy();
    fireEvent.click(slot.getByText("Sign in to Gemini", { selector: "span.block" }));
    expect(await slot.findByText("Finish Google sign-in on this machine.")).toBeTruthy();
    expect(slot.queryByText("Starting sign-in…")).toBeNull();
    expect(slot.queryByLabelText("Gemini device code")).toBeNull();
  });

  it("adds a Devin PAT from its card without offering Codex login", async () => {
    const slot = render([], { "account.add": () => account({ provider: "devin" }) });
    await slot.findByRole("switch", {name:"Route Antigravity threads"});
    const addButtons = await slot.findAllByRole("button", { name: "Add account" });
    fireEvent.pointerDown(within(slot.getByRole("heading",{name:"Devin"}).closest("section")!).getByRole("button",{name:"Add account"}));
    expect(slot.queryByText("Sign in to Codex", { selector: "span.block" })).toBeNull();
    fireEvent.click(await slot.findByText("Add PAT…"));
    const dialog = await slot.findByRole("dialog", { name: "Add PAT for Devin" });
    fireEvent.change(slot.getByLabelText("Devin PAT"), { target: { value: "cog_synthetic" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add key" }));
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
      await slot.findByRole("switch", { name: "Route Claude threads" }),
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
    expect(await slot.findByText(/In flight: 1; queued: 3/)).toBeTruthy();
    fireEvent.click(await slot.findByRole("button",{name:"Advanced"}));
    const input=await slot.findByLabelText("Concurrent requests per account");
    fireEvent.change(input,{target:{value:"0"}});fireEvent.blur(input);
    expect(await slot.findByText("Enter a whole number from 1 to 32.")).toBeTruthy();
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
    fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
    const anthropic = await slot.findByLabelText(
      "Anthropic upstream base URL",
    );
    if (!(anthropic instanceof HTMLInputElement)) {
      throw new Error("Expected the Anthropic config field to be an input.");
    }
    await waitFor(() =>
      expect(anthropic.value).toBe("https://api.anthropic.com"),
    );
    expect(slot.getByLabelText("Codex upstream base URL")).toBeTruthy();
    expect(slot.getByLabelText("Quota switch threshold")).toBeTruthy();

    fireEvent.change(anthropic, { target: { value: "ftp://invalid.example" } });
    fireEvent.blur(anthropic);
    expect(await slot.findByText("Enter an HTTP or HTTPS URL.")).toBeTruthy();
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
    const row = await slot.findByRole("button", { name: "Open person@example.com" });
    expect(within(row).getByText(/80% of limit/)).toBeTruthy();
    expect(within(row).getByText(/in 3 d 4 hr/)).toBeTruthy();
    const short = within(row).getByText("5H").parentElement!;
    expect(within(short).getByText(/limit reached/)).toBeTruthy();
    fireEvent.click(row);
    const card = slot.getByRole("region", { name: "person@example.com" });
    expect(row.getAttribute("aria-controls")).toBe(card.id);
    expect(card.parentElement?.contains(row)).toBe(true);
    expect(card.compareDocumentPosition(slot.getByRole("button", { name: "Open next@example.com" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rule = within(card).getByRole("region", { name: "Weekly rule" });
    fireEvent.click(within(rule).getByRole("button", { name: "Edit weekly rule" }));
    fireEvent.change(within(rule).getByRole("combobox", { name: "Mode" }), { target: { value: "scheduled" } });
    fireEvent.click(within(rule).getByRole("button", { name: "Save weekly rule" }));
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
    neuraldeep: null, nvidia: null, ifm: null, agy: null,
          cursor: null,
          devin: null,
          grok: null, gemini: null,
        }),
    });
    const overviewTrigger = await slot.findByText("Selected accounts", { selector: "summary" });
    const details = overviewTrigger.closest("details");
    expect(details?.open).toBe(false);
    const advancedTrigger = slot.getByRole("button", { name: "Advanced" });
    expect(advancedTrigger.compareDocumentPosition(overviewTrigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(overviewTrigger);
    expect(details?.open).toBe(true);
    expect(within(slot.getByRole("region", { name: "Selected accounts" })).getAllByText("Not selected")).toHaveLength(12);
    expect(slot.getAllByText("Current")).toHaveLength(1);
    expect(slot.getAllByText("Reserve")).toHaveLength(1);
    expect(slot.getByText("current cap 39% (15%→98%)")).toBeTruthy();
  });

  it("uses email instead of display names in the overview, rows and account dialog", async () => {
    const named = account({ label: "Synthetic Display Name", email: "identity@example.com" });
    const slot = render([named], {
      "status.get": () => status([named], { claude: named.id, codex: null, kimi: null, zai: null, "opencode-go": null,
    neuraldeep: null, agy: null, cursor: null, devin: null, grok: null, nvidia: null, ifm: null, gemini: null }),
    });
    fireEvent.click(await slot.findByText("Selected accounts", { selector: "summary" }));
    const overview = await slot.findByRole("region", { name: "Selected accounts" });
    expect(within(overview).getByText("identity@example.com")).toBeTruthy();
    expect(slot.queryByText("Synthetic Display Name")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Open identity@example.com" }));
    expect(await slot.findByRole("heading", { name: "identity@example.com" })).toBeTruthy();
    expect(slot.queryByText("Synthetic Display Name")).toBeNull();
  });

  it("shows missing email explicitly instead of a display name", async () => {
    const slot = render([account({ label: "Hidden Name", email: null })]);
    expect(await slot.findByRole("button", { name: "Open No email set" })).toBeTruthy();
    expect(slot.queryByText("Hidden Name")).toBeNull();
  });

  it("changes a reserve account to primary from inside its detail dialog", async () => {
    const reserved = account({ role: "reserve" });
    const slot = render([reserved], { "account.setRole": () => ({ account: reserved }) });
    fireEvent.click(await slot.findByRole("button", { name: "Open person@example.com" }));
    fireEvent.click(slot.getByText(/Access and route/, { selector: "summary" }));
    fireEvent.click(await slot.findByRole("button", { name: "Change role" }));
    fireEvent.click(await slot.findByRole("button", { name: "Primary" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "account.setRole", input: { accountId: reserved.id, role: "primary" } }));
  });

  it("names the delete confirmation with the selected email", async () => {
    const slot = render([account({ label: "Shared Display Name", email: "selected@example.com" })]);
    fireEvent.click(await slot.findByRole("button", { name: "Open selected@example.com" }));
    fireEvent.click(slot.getByText("Account and actions", { selector: "summary" }));
    fireEvent.pointerDown(slot.getByRole("button", { name: "More account actions" }), { button: 0, ctrlKey: false });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Delete" }));
    expect(await slot.findByRole("dialog", { name: "Delete selected@example.com?" })).toBeTruthy();
    expect(slot.queryByText("Shared Display Name")).toBeNull();
  });

  it("keeps role selection open and reports a rejected save", async () => {
    const slot = render([account({ role: "reserve" })], {
      "account.setRole": () => { throw new Error("Role update failed"); },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Open person@example.com" }));
    fireEvent.click(slot.getByText(/Access and route/, { selector: "summary" }));
    fireEvent.click(await slot.findByRole("button", { name: "Change role" }));
    fireEvent.click(await slot.findByRole("button", { name: "Primary" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect(await within(slot.getByRole("dialog", { name: "Role" })).findByRole("alert")).toHaveProperty("textContent", "Role update failed");
    expect(slot.getByRole("button", { name: "Primary" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("saves a role and a weekly cap from the row actions", async () => {
    const slot = render([account()], {
      "account.setRole": () => ({ account: null }),
      "account.setCap": () => ({ account: null }),
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "Actions: person@example.com" }),
    );
    fireEvent.click(await slot.findByText("Set role…"));
    fireEvent.click(await slot.findByRole("button", { name: "Reserve" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "account.setRole",
        input: { accountId: account().id, role: "reserve" },
      }),
    );
    await waitFor(() => expect(slot.queryByText("Role")).toBeNull());
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "Actions: person@example.com" }),
    );
    fireEvent.click(await slot.findByText("Set weekly cap…"));
    fireEvent.change(await slot.findByLabelText("Cap at start of week"), {
      target: { value: "0.2" },
    });
    fireEvent.change(slot.getByLabelText("Cap at reset"), {
      target: { value: "0.9" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
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
      name: "Balance accounts",
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
    const drain = await slot.findByLabelText("Reserve usage hours");
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
    expect(slot.getByText("Sun, Sat do not count toward the reset.")).toBeTruthy();
    const friday = slot.getByRole("button", { name: "Fri" });
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
    fireEvent.click(slot.getByRole("button", { name: "Sun" }));
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
    expect(await slot.findByText("Usage windows")).toBeTruthy();
    expect(slot.getByText("already open")).toBeTruthy();
    const table = slot.getByLabelText("Claude usage windows");
    expect(slot.queryByLabelText("Codex usage windows")).toBeNull();
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
      await slot.findByText((text) => text.startsWith("Cap · ")),
    ).toBeTruthy();
    expect(slot.getByText("Reserve · standby")).toBeTruthy();
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
    expect(await slot.findByText("7D")).toBeTruthy();
    expect(slot.queryByText("LIMIT 2")).toBeNull();
    fireEvent.click(
      await slot.findByRole("button", { name: "Open codex@example.com" }),
    );
    expect(await slot.findByText("Weekly")).toBeTruthy();
    expect(slot.queryByText("Second limit")).toBeNull();
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
      await slot.findByRole("button", { name: "Open person@example.com" }),
    );
    fireEvent.click(slot.getByText(/Access and route/, { selector: "summary" }));
    fireEvent.click(slot.getByText("Diagnostics", { selector: "summary" }));
    expect(slot.getByText(/Reserve · priority/)).toBeTruthy();
    expect(slot.getByText("15% → 98% · currently 45%")).toBeTruthy();
    expect(slot.getByText("Requests through pool")).toBeTruthy();
    expect(slot.getByText("12 successful since tracking began")).toBeTruthy();
    expect(slot.getAllByText((text) => text.includes("reset") && text.includes("UTC+3"))).toBeTruthy();
    expect(
      slot.getByText(
        "Used only when no primary account is eligible, or within 24 working hours of its weekly reset.",
      ),
    ).toBeTruthy();
    expect(
      within(slot.getByRole("region", { name: "person@example.com" })).getByText((text) => text.includes("limit 45%") && text.includes("of limit")),
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
          { title: "Full reset", expiresAt: Date.parse("2030-10-05T20:17:35Z") },
          { title: "Full reset", expiresAt: Date.parse("2030-10-22T22:12:41Z") },
        ],
        observedAt: Date.now(),
      },
    })]);
    fireEvent.click(await slot.findByRole("button", { name: "Open codex@example.com" }));
    expect(slot.getByText("Saved usage limit resets")).toBeTruthy();
    fireEvent.click(slot.getByText(/Saved usage limit resets/, { selector: "summary" }));
    expect(slot.getAllByText(/Available: 2/)).toHaveLength(2);
    expect(slot.getByText(/expires 5 October 2030.*23:17:35 UTC\+3/)).toBeTruthy();
    expect(slot.getByText(/expires 23 October 2030.*01:12:41 UTC\+3/)).toBeTruthy();
  });

  it("shows Claude saved reset quantity, scope, deadline and usage restriction", async () => {
    const slot = render([account({
      resetCredits: {
        availableCount: 2, observedAt: Date.now(),
        credits: [{ title: "Claude usage limit reset", remaining: 2,
          expiresAt: Date.parse("2030-04-22T09:17:35Z"),
          limitTypes: ["five_hour", "seven_day"], usableNow: false, requiresLimit: true }],
      },
    })]);
    fireEvent.click(await slot.findByRole("button", { name: "Open person@example.com" }));
    fireEvent.click(slot.getByText(/Saved usage limit resets/, { selector: "summary" }));
    expect(slot.getAllByText(/Available: 2/)).toHaveLength(2);
    expect(slot.getByText("Claude usage limit reset · resets: 2")).toBeTruthy();
    expect(slot.getByText(/22 April 2030.*12:17:35 UTC\+3/)).toBeTruthy();
    expect(slot.getByText("Resets: 5 hours, weekly limit")).toBeTruthy();
    expect(slot.getByText("Available after reaching the limit")).toBeTruthy();
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
        name: "Open account card: person@example.com",
      }),
    );
    expect(await slot.findByText("Fable, weekly")).toBeTruthy();
    expect(slot.getByText("Opus, weekly")).toBeTruthy();
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
    expect(await slot.findByRole("button", { name: "Open person@example.com" })).toBeTruthy();
    expect(slot.queryByText("Person Example")).toBeNull();
    expect(slot.getAllByText("person@example.com")).toHaveLength(1);
    fireEvent.click(
      slot.getByRole("button", { name: "Open account card: person@example.com" }),
    );
    fireEvent.click(slot.getByText("Diagnostics", { selector: "summary" }));
    expect(await slot.findByText("Email")).toBeTruthy();
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
    fireEvent.click(await slot.findByRole("button", { name: "Sign in to Codex" }));
    const dialog = await slot.findByRole("dialog", {
      name: "Sign in to Codex",
    });
    expect(slot.getAllByRole("heading", { name: "Sign in to Codex" })).toHaveLength(
      1,
    );
    expect(dialog.textContent).toContain(
      "Open the verification page, sign in to ChatGPT, and enter this code.",
    );
    expect(
      (await slot.findByLabelText("Codex device code")).textContent,
    ).toContain("ABCD-1234");
    expect(slot.queryByRole("button", { name: "Cancel" })).toBeNull();
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
        await slot.findByRole("button", { name: "Sign in to Codex" }),
      );
      await slot.findByRole("dialog", { name: "Sign in to Codex" });
      fireEvent.click(slot.getByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "codexLogin.cancel",
          input: { sessionId: codexLoginStart().sessionId },
        }),
      );
      await waitFor(() =>
        expect(slot.queryByRole("dialog", { name: "Sign in to Codex" })).toBe(null),
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
    const loginButton = await slot.findByRole("button", { name: "Sign in to Codex" });
    await act(async () => {
      fireEvent.click(loginButton);
    });
    const codeCopyButton = await slot.findByRole("button", {
      name: "Copy Codex sign-in code",
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
      expect(await slot.findByText("Sign-in code copied")).toBeTruthy();
      expect(codeCopyButton.querySelector('[data-icon="Check"]')).not.toBeNull();
      expect(expire).toBeTypeOf("function");
      clearTimeout(expirationTimer);
      act(() => expire!());
      expect(slot.queryByText("Sign-in code copied")).toBeNull();
      expect(codeCopyButton.querySelector('[data-icon="Check"]')).toBeNull();
      timerSpy.mockRestore();

      await act(async () => {
        fireEvent.click(slot.getByRole("button", { name: "Copy Codex authorization URL" }));
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
    fireEvent.click(await slot.findByRole("button", { name: "Sign in to Codex" }));
    const button = await slot.findByRole("button", {
      name: "Copy Codex sign-in code",
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(window.getSelection()?.toString()).toBe("ABCD-1234"),
    );
    expect(slot.queryByText("Sign-in code copied")).toBeNull();
    expect(button.querySelector('[data-icon="Check"]')).toBeNull();
  });

  it("does not claim success when copying the authorization URL fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(await slot.findByRole("button", { name: "Sign in to Codex" }));
    const button = await slot.findByRole("button", {
      name: "Copy Codex authorization URL",
    });
    fireEvent.click(button);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(button.textContent).not.toContain("Copied");
    expect(slot.queryByText("Authorization URL copied")).toBeNull();
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
    fireEvent.click(await slot.findByRole("button", { name: "Sign in to Codex" }));
    fireEvent.click(
      await slot.findByRole("button", { name: "Copy Codex sign-in code" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ABCD-1234"));
    expect(
      (await slot.findByRole("dialog", { name: "Sign in to Codex" })).textContent,
    ).toContain("Waiting for authorization");
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
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
        fireEvent.click(slot.getByRole("button", { name: "Sign in to Codex" }));
      });
      const dialog = within(slot.getByRole("dialog", { name: "Sign in to Codex" }));
      expect(dialog.getByLabelText("Codex device code").textContent).toContain(first.userCode);
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
        fireEvent.click(dialog.getByRole("button", { name: "Try again" }));
      });
      expect(start).toHaveBeenCalledTimes(2);
      expect(dialog.getByLabelText("Codex device code").textContent).toContain(second.userCode);
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
        name: "Move first@example.com",
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
          .getAllByRole("button", { name: /Move (first|second)@example\.com/ })
          .map((button) => button.getAttribute("aria-label"));
      expect(providerOrder()).toEqual([
        "Move second@example.com",
        "Move first@example.com",
      ]);
      expect(handle.hasAttribute("disabled")).toBe(true);
      finishSave();
      await waitFor(() => expect(handle.hasAttribute("disabled")).toBe(false));
      expect(providerOrder()).toEqual([
        "Move second@example.com",
        "Move first@example.com",
      ]);
      expect(
        slot
          .getByRole("button", { name: "Move other@example.com" })
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
      name: "Move first@example.com",
    });
    await keyboardMove(handle);
    fireEvent.keyDown(document, { code: "Space" });
    expect(
      await slot.findByText("Refresh the account list and try again."),
    ).toBeTruthy();
    expect(
      slot
        .getAllByRole("button", { name: /Move/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Move first@example.com", "Move second@example.com"]);
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
        name: "Move first@example.com",
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
          .getAllByRole("button", { name: /Move/ })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Move first@example.com", "Move second@example.com"]);
    },
  );
});


const threadAccountHeaderSlot = { component: function Header({ threadId, threadIds = [threadId] }: { threadId: string; threadIds?: string[] }) {
  const registration = app.threadActions[0]!;
  const data = registration.useData!({ threadIds });
  const action = registration.item({ thread: { id: threadId }, data } as Parameters<typeof registration.item>[0]);
  return <>{action ? <button aria-label={`Thread account: ${action.label}`} onClick={() => void action.run({ requestRename: () => {} })}>{action.label}</button> : null}<ThreadAccountOverlay /></>;
} };

describe("thread subscription indicator", () => {
  it("hides the federation refusal and stops polling the remote thread", async () => {
    vi.useFakeTimers();
    try {
      const ui = renderSlot(threadAccountHeaderSlot, {
        threadId: "thr_remote", projectId: "proj_remote", isCompactViewport: true,
      }, {
        rpc: { "thread.account": async () => {
          throw Object.assign(new Error("Plugin RPC is outside federation scope"), {
            code: "federation_plugin_not_federated", status: 409,
          });
        } },
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
      expect(ui.queryByRole("button", { name: /Thread account/ })).toBeNull();
      expect(ui.rpcCalls).toEqual([{ method: "thread.account", input: { threadId: "thr_remote" } }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps showing unrelated pool check errors", async () => {
    const ui = renderSlot(threadAccountHeaderSlot, {
      threadId: "thr_local", projectId: "proj_local", isCompactViewport: false,
    }, {
      rpc: { "thread.account": () => {
        throw Object.assign(new Error("Pool unavailable"), { status: 409 });
      } },
    });
    expect(await ui.findByRole("button", { name: /Pool: status check failed/ })).toBeTruthy();
  });

  it("shows the confirmed account and availability, with details on click", async () => {
    const ui = renderSlot(threadAccountHeaderSlot, { threadId: "thr-test", projectId: "project", isCompactViewport: false }, {
      rpc: { "thread.account": () => ({ state: "observed", account: account({ eligible: false }), lastUsedAt: 1800000000000 }) },
    });
    const button = await ui.findByRole("button", { name: /Thread account: person@example.com · currently unavailable/ });
    fireEvent.click(button);
    expect(await ui.findByText(/Last confirmed request/)).toBeTruthy();
    fireEvent.click(ui.getAllByRole("button", { name: "Close" })[1]!);
    await waitFor(() => expect(ui.queryByRole("dialog")).toBeNull());
  });
  it("does not claim an account before observing a request", async () => {
    const ui = renderSlot(threadAccountHeaderSlot, { threadId: "thr-test", projectId: "project", isCompactViewport: false }, {
      rpc: { "thread.account": () => ({ state: "unobserved", account: null, lastUsedAt: null }) },
    });
    expect(await ui.findByText("Pool: no data yet")).toBeTruthy();
  });
});
it('does not label an armed draining account as outside its closed schedule',async()=>{
 const slot=render([account({drainOnce:true,policy:{enabled:true,fiveHourKeep:null,weeklyKeep:null,reserveDrainHours:null,schedule:{timeZone:'UTC',intervals:[]}}})]);
 await slot.findByText('person@example.com');
 expect(slot.queryByText('Outside schedule')).toBeNull();
});

it('enables fail-closed VPN Guard linkage through the existing autosave config RPC',async()=>{
  const slot=render([],{'config.set':()=>config({vpnGuardEnabled:true})});
  const checkbox=await slot.findByRole('checkbox',{name:'Follow VPN Guard'});
  expect(slot.queryByText(/Old \/1/)).toBeNull();
  fireEvent.click(checkbox);
  await waitFor(()=>expect(slot.rpcCalls).toContainEqual(expect.objectContaining({method:'config.set',input:{vpnGuardEnabled:true}})));
  slot.unmount();
});

it.each(['kimi','zai','opencode-go','cursor','devin'] as const)('shows the observed %s email in the thread header',async provider=>{
 const ui=renderSlot(threadAccountHeaderSlot,{threadId:'thread-one',projectId:'project',isCompactViewport:false},{rpc:{'thread.account':()=>({state:'observed',account:account({provider,kind:'api-key',email:'other@example.com',label:'Subscription'}),lastUsedAt:1800000000000})}});
 expect(await ui.findByRole('button',{name:/Thread account: other@example.com/})).toBeTruthy();
});

it('shows Gemini declared plan, model quota and absolute credits without a fabricated window', async()=>{
 const selected=account({provider:'gemini',geminiUsage:{observedAt:100,plan:{id:'fixture-tier',name:'Fixture Gemini plan'},credits:'0',models:[{modelId:'gemini-fixture',tokenType:'REQUESTS',usedPercent:100,resetAt:null}]}});
 const slot=render([selected]);
 await waitFor(()=>expect(slot.container.textContent).toContain('Fixture Gemini plan'));
 expect(slot.container.textContent).toContain('Google One AI credits: 0');
 expect(slot.container.textContent).toContain('gemini-fixture');
});

it('distinguishes Gemini token types without claiming a per-model routing threshold',async()=>{
 const selected=account({provider:'gemini',geminiUsage:{observedAt:100,plan:null,credits:null,models:[
  {modelId:'gemini-fixture',tokenType:'REQUESTS',usedPercent:0,resetAt:null},
  {modelId:'gemini-fixture',tokenType:'WTUS',usedPercent:100,resetAt:null},
 ]}});
 const slot=render([selected]);
 await waitFor(()=>expect(slot.container.textContent).toContain('gemini-fixture · REQUESTS'));
 expect(slot.container.textContent).toContain('gemini-fixture · WTUS');
 fireEvent.click(slot.getByRole('button',{name:`Open ${selected.label}`}));
 const details=await slot.findByLabelText('Gemini model quotas');
 expect(details.textContent).toContain('gemini-fixture · REQUESTS');
 expect(details.textContent).toContain('gemini-fixture · WTUS');
 expect(details.textContent).not.toContain('skip at');
});

it('submits the pasted Gemini code from a password field to the current login session',async()=>{
 const selected=account({provider:'gemini'});
 const slot=render([selected],{
  'geminiLogin.reauthorize':()=>({sessionId:'fixture-session',verificationUri:'https://accounts.google.com/device',userCode:null,expiresAt:Date.now()+600000,intervalMs:1000}),
  'geminiLogin.poll':()=>({status:'pending'}),
  'geminiLogin.submitCode':()=>({accepted:true}),
 });
 fireEvent.click(await slot.findByRole('button',{name:`Open ${selected.label}`}));
 fireEvent.pointerDown(slot.getByRole('button',{name:'More account actions'}),{button:0,ctrlKey:false});
 fireEvent.click(await slot.findByRole('menuitem',{name:'Sign in again'}));
 const input=await slot.findByLabelText('Gemini authorization code');
 expect(input.getAttribute('type')).toBe('password');
 fireEvent.change(input,{target:{value:'synthetic-google-code'}});
 fireEvent.click(slot.getByRole('button',{name:'Finish'}));
 await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'geminiLogin.submitCode',input:{sessionId:'fixture-session',code:'synthetic-google-code'}}));
 await waitFor(()=>expect((input as HTMLInputElement).value).toBe(''));
});

it('offers Gemini sign-in again for the selected account without adding a replacement or exposing provider JSON',async()=>{
 const selected=account({provider:'gemini',enabled:false,status:'error',error:'{"reason":"SUBSCRIPTION_REQUIRED","message":"synthetic-private-marker"}'});
 const slot=render([selected],{
  'geminiLogin.reauthorize':()=>({sessionId:'fixture-session',verificationUri:'https://accounts.google.com/device',userCode:null,expiresAt:Date.now()+600000,intervalMs:1000}),
  'geminiLogin.poll':()=>({status:'pending'}),
 });
 fireEvent.click(await slot.findByRole('button',{name:`Open ${selected.label}`}));
 expect(slot.getByText(/Gemini requires a valid subscription/)).toBeTruthy();
 expect(slot.queryByText(/synthetic-private-marker/)).toBeNull();
 fireEvent.pointerDown(slot.getByRole('button',{name:'More account actions'}),{button:0,ctrlKey:false});
 fireEvent.click(await slot.findByRole('menuitem',{name:'Sign in again'}));
 await slot.findByRole('dialog',{name:'Reauthorize Gemini'});
 expect(slot.rpcCalls).toContainEqual({method:'geminiLogin.reauthorize',input:{accountId:selected.id}});
 expect(slot.rpcCalls.some(call=>call.method==='geminiLogin.start'||call.method==='account.add')).toBe(false);
});

it('keeps a saved account awaiting login with a dedicated sign-in action',async()=>{
 const a=account({draft:true,enabled:false,status:'disabled',label:'Prepared subscription'});
 const slot=render([a],{'login.reauthorize':()=>({sessionId:'fixture-session',authorizeUrl:'https://login.example/authorize'})});
 await waitFor(()=>expect(slot.getByText('Awaiting sign-in')).toBeTruthy());
 fireEvent.click(await slot.findByRole('button',{name:'Open account card: person@example.com'}));
 fireEvent.click(await slot.findByRole('button',{name:'Sign in to account'}));
 await waitFor(()=>expect(slot.rpcCalls).toContainEqual({method:'login.reauthorize',input:{accountId:a.id}}));
 expect(slot.rpcCalls.some(c=>c.method==='account.enable')).toBe(false);
});

it.each([false,true])('switches subscription inside the existing dialog; RPC error=%s',async fails=>{
 const id='11111111-1111-4111-8111-111111111111';
 const choices={currentAccountId:null,mode:'auto',pinned:false,accounts:[{id,label:'person@example.test',state:'ready',until:null,selectable:true,assigned:true}]};
 const ui=renderSlot(threadAccountHeaderSlot,{threadId:'thr-test',projectId:'project',isCompactViewport:true},{
  rpc:{'thread.account':()=>({state:'unobserved',account:null,lastUsedAt:null}),
   'thread.accountChoices':()=>choices,
   'thread.switchAccount':(input:unknown)=>{const selected=input as {accountId:string|null};if(fails)throw Error('synthetic');return {...choices,currentAccountId:selected.accountId,mode:selected.accountId?'manual':'auto',pinned:!!selected.accountId};}}
 });
 fireEvent.click(await ui.findByRole('button',{name:/Thread account/}));
 fireEvent.click(await ui.findByRole('button',{name:/person@example.test/}));
 if(fails){expect(await ui.findByRole('alert')).toBeTruthy();expect(ui.getByRole('button',{name:'Automatic (default)'}).getAttribute('aria-pressed')).toBe('true');}
 else{
  await waitFor(()=>expect(ui.getByRole('button',{name:/person@example.test/}).getAttribute('aria-pressed')).toBe('true'));
  expect(ui.rpcCalls).toContainEqual({method:'thread.switchAccount',input:{threadId:'thr-test',accountId:id}});
  fireEvent.click(ui.getByRole('button',{name:'Automatic (default)'}));
  await waitFor(()=>expect(ui.getByRole('button',{name:'Automatic (default)'}).getAttribute('aria-pressed')).toBe('true'));
 }
});

it.each(['ready','disabled'] as const)('uses thread choice state %s for confirmed reserve account',async state=>{
 const a=account({email:'person@example.test',role:'reserve',eligible:false});
 const choices={currentAccountId:a.id,mode:'auto',pinned:false,accounts:[{id:a.id,label:'person@example.test',state,until:null,selectable:state==='ready',assigned:false}]};
 const ui=renderSlot(threadAccountHeaderSlot,{threadId:'thr-test',projectId:'project',isCompactViewport:false},{
  rpc:{'thread.account':()=>({state:'observed',account:a,lastUsedAt:1800000000000}),'thread.accountChoices':()=>choices}
 });
 fireEvent.click(await ui.findByRole('button',{name:/Thread account: person@example.test · currently unavailable/}));
 const expected=state==='ready'?"ready":"disabled";
 await waitFor(()=>expect(ui.getByRole('button',{name:'Thread account: person@example.test · '+expected,hidden:true})).toBeTruthy());
 expect(ui.getByText(/Last confirmed request/).textContent).toContain('person@example.test · '+expected);
});

it('summarizes matching Gemini reports without inventing a shared limit or hiding the detailed identifiers',async()=>{
 const selected=account({provider:'gemini',geminiUsage:{observedAt:100,plan:null,credits:null,models:[
  {modelId:'gemini-fixture-a',tokenType:'WTUS',usedPercent:5,resetAt:null},
  {modelId:'gemini-fixture-b',tokenType:'WTUS',usedPercent:5,resetAt:null},
 ]}});
 const slot=render([selected]);
 await waitFor(()=>expect(slot.container.textContent).toContain('2 matching reports · WTUS'));
 expect(slot.container.textContent).not.toContain('gemini-fixture-a');
 fireEvent.click(slot.getByRole('button',{name:`Open ${selected.label}`}));
 const details=await slot.findByLabelText('Gemini model quotas');
 expect(details.textContent).toContain('gemini-fixture-a · WTUS');
 expect(details.textContent).toContain('gemini-fixture-b · WTUS');
 expect(details.textContent).not.toContain('skip at');
});
