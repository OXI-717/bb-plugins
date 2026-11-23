import { describe, expect, it } from "vitest";
import { accountPoolConfigSchema, providerSchema, statusSchema } from "./contracts.js";

const status = {
  route: "/http",
  enabledAccountCount: 0,
  inFlight: 0,
  accepting: true,
  hosts: [],
  accounts: [],
  activeAccounts: {
    claude: null,
    codex: null,
    kimi: null,
    zai: null,
    "opencode-go": null,
    neuraldeep: null, nvidia: null, ifm: null,
    agy: null,
    cursor: null,
    devin: null,
    grok: null,
    gemini: null,
  },
  routing: {
    claude: true,
    codex: true,
    kimi: true,
    zai: true,
    "opencode-go": true,
    neuraldeep: true, nvidia: true, ifm: true,
    agy: true,
    cursor: true,
    devin: true,
    grok: true,
    gemini: true,
  },
};

describe("gemini provider identity", () => {
  it("accepts gemini and defaults the API host", () => {
    expect(providerSchema.parse("gemini")).toBe("gemini");
    expect(accountPoolConfigSchema.parse({}).geminiUpstreamBaseUrl).toBe(
      "https://generativelanguage.googleapis.com",
    );
    expect(statusSchema.parse(status).activeAccounts.gemini).toBeNull();
    const { gemini: _gemini, ...activeWithout } = status.activeAccounts;
    expect(statusSchema.safeParse({ ...status, activeAccounts: activeWithout }).success).toBe(false);
  });
});
