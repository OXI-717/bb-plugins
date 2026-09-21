import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExternalClients, combinedTokens } from "./external-clients.js";
import { HubTokenStore } from "./store.js";

it("keeps external tokens across host pruning, revokes immediately, and writes privately", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "external-test-"));
  try {
    const hosts = new HubTokenStore(path.join(dir, "hosts"));
    const clients = new ExternalClients(path.join(dir, "clients"));
    const output = path.join(dir, "client.token");
    await clients.add("orca", output);
    const token = (await fs.readFile(output, "utf8")).trim();
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
    const both = combinedTokens(hosts, clients.tokens);
    await hosts.prune([]);
    expect(await both.authenticate(token)).toBe("external_orca");
    const restored = new ExternalClients(path.join(dir, "clients"));
    expect(await restored.tokens.authenticate(token)).toBe("external_orca");
    await expect(clients.add("orca", output)).rejects.toThrow();
    await clients.revoke("orca");
    expect(await both.authenticate(token)).toBeNull();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
