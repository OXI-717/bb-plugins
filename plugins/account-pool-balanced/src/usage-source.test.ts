import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { EMPTY_FAMILY_WEEKLY } from "./contracts.js";
import type { AccountPoolHub } from "./hub.js";
import { usageFetchMethod, usageListMethod, usageMeasurementSchema, usageResourceListSchema } from "./usage-contract.js";
import {
  registerUsageSource,
  usagePlanLabel,
  usageResourceLabel,
  usageWindowLabel,
  USAGE_PROVIDER_IDS,
} from "./usage-source.js";

describe("usage presentation labels", () => {
  it("prefixes provider name and account label/email without duplicating the provider", () => {
    expect(
      usageResourceLabel({
        provider: "claude",
        label: "primary",
        email: "work@example.com",
      }),
    ).toBe("Claude Code · primary (work@example.com)");
    expect(
      usageResourceLabel({
        provider: "grok",
        label: "work@example.com",
        email: "work@example.com",
      }),
    ).toBe("Grok · work@example.com");
    expect(
      usageResourceLabel({
        provider: "gemini",
        label: "work@example.com",
        email: "work@example.com",
      }),
    ).toBe("Gemini · work@example.com");
    expect(
      usageResourceLabel({
        provider: "zai",
        label: "GLM",
        email: null,
      }),
    ).toBe("Z.ai Coding Plan · GLM");
    expect(
      usageResourceLabel({
        provider: "claude",
        label: "Claude Code · primary",
        email: "work@example.com",
      }),
    ).toBe("Claude Code · primary");
    expect(
      usageResourceLabel({
        provider: "claude",
        label: "Claude Code",
        email: null,
      }),
    ).toBe("Claude Code");
  });
  it("hides expired reset windows while keeping active windows on usage fetch and reports OAUTH_REAUTH_REQUIRED as expired", async () => {
    const now = Date.parse("2026-11-21T12:00:00Z");
    let handlers: Record<string, (input: { resourceId: string; refresh: boolean }) => Promise<unknown>> = {};
    const bb = {
      rpc: {
        register: (_contract: unknown, methods: typeof handlers) => {
          handlers = methods;
        },
      },
    } as unknown as BbPluginApi;
    const hub = {
      status: async () => ({
        accounts: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            provider: "claude" as const,
            label: "primary",
            email: "work@example.com",
            accountUuid: "00000000-0000-4000-8000-000000000011",
            subscriptionType: "max",
            rateLimitTier: "default_claude_max_20x",
            fiveHourUtilization: 0.62,
            fiveHourResetAt: Date.parse("2026-11-03T05:39:59Z"),
            sevenDayUtilization: 0.99,
            sevenDayResetAt: Date.parse("2026-11-24T14:59:59Z"),
            limitWindows: [],
            familyWeekly: EMPTY_FAMILY_WEEKLY,
            observedAt: now,
            error: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            provider: "claude" as const,
            label: "reserve",
            email: "team@example.com",
            accountUuid: "00000000-0000-4000-8000-000000000022",
            subscriptionType: "max",
            rateLimitTier: "default_claude_max_20x",
            fiveHourUtilization: 0.16,
            fiveHourResetAt: Date.parse("2026-10-31T02:39:59Z"),
            sevenDayUtilization: 0.88,
            sevenDayResetAt: Date.parse("2026-11-21T05:59:59Z"),
            limitWindows: [],
            familyWeekly: EMPTY_FAMILY_WEEKLY,
            observedAt: Date.parse("2026-11-19T10:32:48Z"),
            error: "[OAUTH_REAUTH_REQUIRED] OAuth refresh failed with HTTP 400. OAuth: invalid_grant. Sign in again.",
          },
        ],
      }),
      assertNetworkAllowed: vi.fn(async () => {}),
      refreshUsage: vi.fn(async (id?: string) => {
        if (id === "00000000-0000-4000-8000-000000000002") {
          throw new Error("[OAUTH_REAUTH_REQUIRED] OAuth refresh failed with HTTP 400. OAuth: invalid_grant. Sign in again.");
        }
      }),
    } as unknown as AccountPoolHub;
    registerUsageSource(bb, hub, false, () => now);
    const list = usageResourceListSchema.parse(await handlers[usageListMethod]!({ resourceId: "", refresh: false }));
    expect(list.resources[0]?.label).toBe("Claude Code · primary (work@example.com)");
    expect(list.resources[1]?.label).toBe("Claude Code · reserve (team@example.com)");
    const measurement = usageMeasurementSchema.parse(
      await handlers[usageFetchMethod]!({
        resourceId: "00000000-0000-4000-8000-000000000001",
        refresh: false,
      }),
    );
    expect(measurement.usage).toMatchObject({
      status: "ok",
      accountEmail: null,
      planLabel: "Max (20x)",
      windows: [
        {
          id: "weekly",
          label: "Weekly limit",
          usedPercent: 99,
          resetsAt: "2026-11-24T14:59:59.000Z",
        },
      ],
    });
    const expiredMeasurement = usageMeasurementSchema.parse(
      await handlers[usageFetchMethod]!({
        resourceId: "00000000-0000-4000-8000-000000000002",
        refresh: true,
      }),
    );
    expect(expiredMeasurement.usage).toMatchObject({
      status: "expired",
      accountEmail: null,
      planLabel: "Max (20x)",
    });
  });
  it("names known windows consistently and retains other durations", () => {
    expect(usageWindowLabel(10_080, "primary")).toBe("Weekly limit");
    expect(usageWindowLabel(300, "secondary")).toBe("Five-hour limit");
    expect(usageWindowLabel(43_200, "secondary")).toBe("Monthly limit");
    expect(usageWindowLabel(1_440, "primary")).toBe("Daily limit");
    expect(usageWindowLabel(2_880, "primary")).toBe("2 day limit");
    expect(usageWindowLabel(null, "Custom limit")).toBe("Custom limit");
  });
  it("retains known Max multipliers without inventing a missing tier", () => {
    expect(
      usagePlanLabel({
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      }),
    ).toBe("Max (20x)");
    expect(
      usagePlanLabel({ subscriptionType: "max", rateLimitTier: null }),
    ).toBe("Max");
    expect(
      usagePlanLabel({ subscriptionType: "pro", rateLimitTier: null }),
    ).toBe("Pro");
    expect(
      usagePlanLabel({ subscriptionType: null, rateLimitTier: null }),
    ).toBeNull();
  });
});

describe("pooled providers on the usage surface", () => {
  it("names a BB provider for every pooled subscription", () => {
    // The map is exhaustive by type, but the values are ours: a wrong id puts the
    // subscription's windows under someone else's card, or under none at all.
    expect(USAGE_PROVIDER_IDS).toEqual({
      claude: "claude-code",
      codex: "codex",
      agy: "acp-agy",
      kimi: "acp-opencode-kimi",
      zai: "acp-opencode-zai",
      "opencode-go": "acp-opencode-go",
      neuraldeep: "acp-opencode-neuraldeep",
      nvidia: "acp-opencode-nvidia",
      ifm: "acp-opencode-ifm",
      cursor: "acp-oxi-cursor",
      devin: "acp-devin",
      grok: "acp-grok",
      gemini: "acp-antigravity",
    });
    expect(new Set(Object.values(USAGE_PROVIDER_IDS)).size).toBe(
      Object.keys(USAGE_PROVIDER_IDS).length,
    );
  });
});

it('exposes Gemini models and declared plan, with absolute credits in the existing resource label',async()=>{
 let handlers:Record<string,(input: {resourceId:string;refresh:boolean})=>Promise<unknown>>={};
 const bb={rpc:{register:(_contract:unknown,methods:typeof handlers)=>{handlers=methods;}}} as unknown as BbPluginApi;
 const account={id:'00000000-0000-4000-8000-000000000001',provider:'gemini',label:'Synthetic',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,observedAt:100,error:null,limitWindows:[],familyWeekly:EMPTY_FAMILY_WEEKLY,
 geminiUsage:{observedAt:100,plan:{id:'fixture-tier',name:'Fixture plan'},credits:'12',models:[{modelId:'gemini-fixture',tokenType:'REQUESTS',usedPercent:0,resetAt:null},{modelId:'gemini-fixture-pro',tokenType:'WTUS',usedPercent:100,resetAt:200}]}};
 const hub={status:async()=>({accounts:[account]}),assertNetworkAllowed:vi.fn(),refreshUsage:vi.fn()} as unknown as AccountPoolHub;
 registerUsageSource(bb,hub,false,()=>100);
 const list=usageResourceListSchema.parse(await handlers[usageListMethod]!({resourceId:'',refresh:false}));
 expect(list.resources[0]?.label).toContain('Google One AI credits: 12');
 const result=usageMeasurementSchema.parse(await handlers[usageFetchMethod]!({resourceId:account.id,refresh:false}));
 expect(result.usage.status).toBe('ok');
 if(result.usage.status!=='ok')throw Error('measurement failed');
 expect(result.usage.plan).toEqual({id:'fixture-tier',multiplier:null});expect(result.usage.planLabel).toBe('Fixture plan');
 expect(result.usage.windows.map(w=>w.usedPercent)).toEqual([0,100]);expect(result.usage.windows.map(w=>w.model)).toEqual(['gemini-fixture','gemini-fixture-pro']);
 expect(result.usage.windows[0]?.resetsAt).toBeNull();expect(result.usage.windows[1]?.resetsAt).toBe(new Date(200).toISOString());
 expect(result.usage.windows.every(w=>w.cost===null)).toBe(true);
});

it.each([
 {name:'matching reports',changes:{},expected:1},
 {name:'different token types',changes:{tokenType:'REQUESTS'},expected:2},
 {name:'different percentages',changes:{usedPercent:6},expected:2},
 {name:'different resets',changes:{resetAt:300},expected:2},
 {name:'unknown token type',changes:{tokenType:null},expected:2},
])('groups Gemini $name only as a display summary',async({changes,expected})=>{
 let handlers:Record<string,(input:{resourceId:string;refresh:boolean})=>Promise<unknown>>={};
 const bb={rpc:{register:(_contract:unknown,methods:typeof handlers)=>{handlers=methods;}}} as unknown as BbPluginApi;
 const first={modelId:'gemini-fixture-a',tokenType:'WTUS',usedPercent:5,resetAt:200};
 const second={...first,modelId:'gemini-fixture-b',...changes};
 const account={id:'00000000-0000-4000-8000-000000000001',provider:'gemini',label:'Synthetic',email:null,accountUuid:null,subscriptionType:null,rateLimitTier:null,observedAt:100,error:null,limitWindows:[],familyWeekly:EMPTY_FAMILY_WEEKLY,
  geminiUsage:{observedAt:100,plan:null,credits:null,models:[first,second]}};
 const original=JSON.stringify(account);
 const hub={status:async()=>({accounts:[account]}),assertNetworkAllowed:vi.fn(),refreshUsage:vi.fn()} as unknown as AccountPoolHub;
 registerUsageSource(bb,hub,false,()=>100);
 const result=usageMeasurementSchema.parse(await handlers[usageFetchMethod]!({resourceId:account.id,refresh:false}));
 if(result.usage.status!=='ok')throw Error('measurement failed');
 expect(result.usage.windows).toHaveLength(expected);
 if(expected===1){
  expect(result.usage.windows[0]).toMatchObject({label:'2 matching reports · WTUS',usedPercent:5,model:null,resetsAt:new Date(200).toISOString()});
 }else expect(result.usage.windows.map(w=>w.model)).toEqual([first.modelId,second.modelId]);
 expect(JSON.stringify(account)).toBe(original);
});
