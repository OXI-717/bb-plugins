import { describe, expect, it } from "vitest";
import {
  accountPoolConfigSchema,
  providerSchema,
  statusSchema,
} from "./contracts.js";

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
    neuraldeep: null,
    agy: null,
    cursor: null,
    devin: null,
    grok: null,
  },
  routing: {
    claude: true,
    codex: true,
    kimi: true,
    zai: true,
    "opencode-go": true,
    neuraldeep: true,
    agy: true,
    cursor: true,
    devin: true,
    grok: true,
  },
};

describe("Grok provider identity", () => {
  it("accepts Grok and defaults the upstream to the xAI API", () => {
    expect(providerSchema.parse("grok")).toBe("grok");
    expect(accountPoolConfigSchema.parse({}).grokUpstreamBaseUrl).toBe(
      "https://api.x.ai/v1",
    );
    expect(statusSchema.parse(status).activeAccounts.grok).toBeNull();
    const { grok: _grok, ...activeWithout } = status.activeAccounts;
    expect(
      statusSchema.safeParse({ ...status, activeAccounts: activeWithout })
        .success,
    ).toBe(false);
  });
});
