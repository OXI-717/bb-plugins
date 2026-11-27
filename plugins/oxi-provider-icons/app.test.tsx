import { describe, expect, it, vi } from "vitest";

/**
 * A small collector stand-in for the SDK's definePluginApp: it invokes the
 * app factory once with a minimal `app` object and records every
 * `experimental_providerIcon` registration. The host resolver is not
 * reproduced here; the host-side contract is covered by the runtime proof.
 */
const state = vi.hoisted(() => ({
  registrations: [] as Array<{
    providerKind: string;
    providerId: string;
    icon: unknown;
  }>,
}));

vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (factory: (app: unknown) => unknown) => {
    factory({
      slots: {
        experimental_providerIcon: (registration: {
          providerKind: string;
          providerId: string;
          icon: unknown;
        }) => {
          state.registrations.push(registration);
        },
      },
    });
    return factory;
  },
}));

import "./app.js";
import { providerIconIds, providerIconRegistry } from "./icons.js";

const EXPECTED_IDS = [
  "acp-agy",
  "acp-opencode-kimi",
  "acp-oxi-cursor",
  "acp-oxi-devin-pool",
  "acp-opencode-go",
  "acp-opencode-zai",
  "acp-opencode-neuraldeep",
];

const UNCLAIMED_IDS = [
  "codex",
  "claude-code",
  "acp-cursor",
  "acp-grok",
  "unknown-provider",
];

describe("app registration", () => {
  it("registers exactly the seven public-safe agent provider ids", () => {
    expect(state.registrations).toHaveLength(EXPECTED_IDS.length);
    expect(state.registrations.map((r) => r.providerId).sort())
      .toEqual([...EXPECTED_IDS].sort());
  });

  it("registers every mark with providerKind agent", () => {
    expect(state.registrations).toHaveLength(providerIconIds.length);
    for (const registration of state.registrations) {
      expect(registration.providerKind).toBe("agent");
    }
  });

  it("does not claim built-in, Grok or unknown providers", () => {
    const claimed = new Set(state.registrations.map((r) => r.providerId));
    for (const id of UNCLAIMED_IDS) {
      expect(claimed.has(id), `must not claim ${id}`).toBe(false);
    }
  });

  it("binds each id to its registry component, all distinct", () => {
    for (const registration of state.registrations) {
      const component = providerIconRegistry[
        registration.providerId as keyof typeof providerIconRegistry
      ];
      expect(registration.icon).toBe(component);
    }
    const icons = new Set(state.registrations.map((r) => r.icon));
    expect(icons.size).toBe(providerIconIds.length);
  });
});
