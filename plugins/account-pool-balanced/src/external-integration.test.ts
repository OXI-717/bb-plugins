import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAccountPoolPlugin } from "./server.js";

it("BB CLI provisions an external client that shares the pool and can be revoked", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-external-"));
  const host = createFakePluginHost({ pluginId: "account-pool-balanced", dataDir, sdk: { hosts: { list: async () => [] }, system: { providerStates: async () => ({ providers: [] }) } } });
  const seen: string[] = [];
  await createAccountPoolPlugin({ fetch: (async (_url, init) => {
    seen.push(new Headers(init?.headers).get("x-api-key") ?? "");
    return Response.json({ content: [{ type: "text", text: "ok" }] });
  }) as typeof fetch })(host.bb);
  const service = host.harness.behavior.runService("hub");
  try {
    await host.harness.behavior.callRpc("account.add", { provider: "claude", source: { kind: "api-key", apiKey: "synthetic-upstream-key" }, label: "fixture", priority: 0 });
    const file = path.join(dataDir, "external.token");
    const added = await host.harness.behavior.runCli(["client", "add", "orca", "--output", file]);
    expect(added.exitCode).toBe(0);
    const token = (await fs.readFile(file, "utf8")).trim();
    expect(added.stdout).not.toContain(token);
    // Status prunes departed BB hosts; external clients must survive it.
    await host.harness.behavior.runCli(["status"]);
    const request = () => host.harness.behavior.fetchHttp("POST", "/v1/messages", { headers: { "x-api-key": token, "content-type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet", max_tokens: 10, messages: [{ role: "user", content: "test" }] }) });
    const result = await request();
    expect(result.status).toBe(200);
    await result.text();
    expect(seen).toContain("synthetic-upstream-key");
    expect(seen).not.toContain(token);
    await host.harness.behavior.runCli(["client", "revoke", "orca"]);
    expect((await request()).status).toBe(401);
  } finally {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
