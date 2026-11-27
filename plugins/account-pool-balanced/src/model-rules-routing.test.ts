import { createFakePluginHost, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAccountPoolPlugin } from "./management-test-fixture.js";
import { vpnProof } from "./vpn-test-fixture.js";
import type { Account } from "./contracts.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

/** Two synthetic Claude accounts; A has the better priority. The upstream records which key it was called with. */
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "pool-model-rules-"));
  const host = createFakePluginHost({
    pluginId: "account-pool-balanced", dataDir: dir,
    sdk: { hosts: { list: async () => [makeHostResponse({ id: "host-one" })] }, system: { providerStates: async () => ({ providers: [] }) } },
  });
  const calls: string[] = [];
  const upstream: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const key = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
    calls.push(key);
    return Response.json({ id: "synthetic-response", type: "message", content: [], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  await createAccountPoolPlugin({ fetch: upstream, fetchIpv4: upstream, vpnPayload: async now => vpnProof(now, "connected") })(host.bb);
  const service = host.harness.behavior.runService("hub");
  cleanup.push(async () => { service.controller.abort(); await service.done; await host.harness.lifecycle.dispose(); await rm(dir, { recursive: true, force: true }); });
  const call = (method: string, input: unknown) => host.harness.behavior.callRpc(method, input);
  const add = async (apiKey: string, priority: number) =>
    await call("account.add", { provider: "claude", source: { kind: "api-key", apiKey }, label: apiKey, priority }) as Account;
  const a = await add("synthetic-key-a", 0);
  const b = await add("synthetic-key-b", 1);
  // Each conversation sticks to the account it started on, so every request here is its own conversation.
  let conversation = 0;
  const send = async (model: string) => {
    const env = await host.harness.behavior.resolveProviderEnv("claude-code", { threadId: `thread-${++conversation}`, projectId: "project-one", hostId: "host-one" });
    const token = env.find(entry => entry.name === "ANTHROPIC_AUTH_TOKEN")!.value as string;
    return host.harness.behavior.fetchHttp("POST", "/v1/messages", {
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 8, messages: [{ role: "user", content: "synthetic" }] }),
    });
  };
  return { call, a, b, calls, send };
}

it("keeps today's choice for a model without a rule", async () => {
  const { a, calls, send } = await setup();
  expect((await send("model-plain")).status).toBe(200);
  expect(calls).toEqual(["synthetic-key-a"]);
  expect(a.id).toBeTruthy();
});

it("sends a pinned model to its account although another has the better priority and is the current one", async () => {
  const { call, b, calls, send } = await setup();
  expect((await send("model-other")).status).toBe(200);
  expect(calls).toEqual(["synthetic-key-a"]);
  await call("account.setModelRules", { accountId: b.id, modelRules: [{ pattern: "model-pinned*", mode: "pin" }] });
  expect((await send("model-pinned-large")).status).toBe(200);
  expect(calls).toEqual(["synthetic-key-a", "synthetic-key-b"]);
});

it("keeps a denied model off the account", async () => {
  const { call, a, calls, send } = await setup();
  await call("account.setModelRules", { accountId: a.id, modelRules: [{ pattern: "model-denied", mode: "deny" }] });
  expect((await send("model-denied")).status).toBe(200);
  expect(calls).toEqual(["synthetic-key-b"]);
});

it("tells the caller the pinned account cannot serve instead of using another account", async () => {
  const { call, b, calls, send } = await setup();
  await call("account.setModelRules", { accountId: b.id, modelRules: [{ pattern: "model-pinned", mode: "pin" }] });
  await call("account.disable", { id: b.id });
  const response = await send("model-pinned");
  expect(response.status).toBe(429);
  expect(response.headers.get("x-bb-pool-error")).toBe("POOL_MODEL_PINNED_UNAVAILABLE");
  expect(await response.text()).toContain("model-pinned");
  expect(calls).toEqual([]);
});

it("lets the other accounts take over when the rule allows a fallback", async () => {
  const { call, b, calls, send } = await setup();
  await call("account.setModelRules", { accountId: b.id, modelRules: [{ pattern: "model-pinned", mode: "pin", fallback: true }] });
  await call("account.disable", { id: b.id });
  expect((await send("model-pinned")).status).toBe(200);
  expect(calls).toEqual(["synthetic-key-a"]);
});
