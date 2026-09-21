import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { openPool } from "./runtime.js";
import { listenPool } from "./http.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function directory() {
  const dir = await mkdtemp(path.join(tmpdir(), "pool-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

it("persists accounts and client identity across standalone restarts", async () => {
  const dir = await directory();
  const first = await openPool(dir);
  const account = await first.accounts.add({ provider: "claude", kind: "api-key", label: "fixture", email: null, accountUuid: null, subscriptionType: null, rateLimitTier: null, enabled: true, priority: 0 }, { kind: "api-key", apiKey: "synthetic-upstream" });
  const token = await first.tokens.forHost("test-client");
  await first.close();
  const second = await openPool(dir);
  cleanups.push(() => second.close());
  expect((await second.accounts.list()).map(a => a.id)).toEqual([account.id]);
  expect(await second.tokens.authenticate(token)).toBe("test-client");
});

it("authenticates external clients, streams through the shared hub and rejects unknown paths", async () => {
  const calls: Array<{ url: string; key: string | undefined }> = [];
  const upstream = createServer((req, res) => {
    calls.push({ url: req.url!, key: req.headers["x-api-key"] as string });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.end("data: last\n\n");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve())));
  const address = upstream.address() as { port: number };
  const pool = await openPool(await directory(), { anthropicUpstreamBaseUrl: `http://127.0.0.1:${address.port}` });
  cleanups.push(() => pool.close());
  await pool.accounts.add({ provider: "claude", kind: "api-key", label: "fixture", email: null, accountUuid: null, subscriptionType: null, rateLimitTier: null, enabled: true, priority: 0 }, { kind: "api-key", apiKey: "synthetic-upstream" });
  const token = await pool.tokens.forHost("external-client");
  const server = await listenPool(pool, { port: 0 });
  cleanups.push(() => server.close());
  const payload = JSON.stringify({ model: "claude-sonnet", max_tokens: 10, messages: [{ role: "user", content: "test" }] });
  expect((await fetch(`${server.url}/v1/messages`, { method: "POST", body: payload })).status).toBe(401);
  expect(calls).toHaveLength(0);
  const response = await fetch(`${server.url}/v1/messages`, { method: "POST", headers: { "x-api-key": token, "content-type": "application/json" }, body: payload });
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("data: first\n\ndata: last\n\n");
  expect(calls).toEqual([{ url: "/v1/messages", key: "synthetic-upstream" }]);
  expect((await fetch(`${server.url}/admin/secrets`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
  expect(calls).toHaveLength(1);
});

it("refuses a second process opening the same pool directory", async () => {
  const dir = await directory();
  const pool = await openPool(dir);
  cleanups.push(() => pool.close());
  await expect(openPool(dir)).rejects.toThrow(/already in use/);
});

it("refuses unrelated nonempty directories, including BB state", async () => {
  const dir = await directory();
  await writeFile(path.join(dir, "bb.db"), "synthetic marker");
  await expect(openPool(dir)).rejects.toThrow(/empty directory/);
});
