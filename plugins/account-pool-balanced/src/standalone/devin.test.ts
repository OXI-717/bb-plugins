import { expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevinPool } from "./devin.js";
import type { PoolKvStorage } from "../core-storage.js";

async function fixture(fetcher: typeof fetch) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "devin-test-"));
  const values = new Map<string, unknown>();
  const kv: PoolKvStorage = { async get(k) { return values.get(k); }, async set(k,v) { values.set(k,v); }, async delete(k) { values.delete(k); }, async list(p = "") { return [...values.keys()].filter(k => k.startsWith(p)); } };
  const pool = new DevinPool(kv, dir, fetcher);
  await pool.add({ id: "one", organizationId: "org-one", apiKey: "synthetic-one", maxAcuLimit: 5 });
  await pool.add({ id: "two", organizationId: "org-two", apiKey: "synthetic-two", maxAcuLimit: 10 });
  return { pool, kv, dir, close: () => fs.rm(dir, { recursive: true, force: true }) };
}

it("keeps sessions on their original account and scopes access to the creating client", async () => {
  const calls: Array<{ url: string; auth: string; body: unknown }> = [];
  const f = await fixture((async (url, init) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization")!, body: init?.body ? JSON.parse(String(init.body)) : null });
    return Response.json({ session_id: "session-one", status: "running", acus_consumed: 1 });
  }) as typeof fetch);
  try {
    await f.pool.create("client-a", { prompt: "test", account: "one", max_acu_limit: 3 });
    const reopened = new DevinPool(f.kv, f.dir, (async (url, init) => { calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization")!, body: null }); return Response.json({ status: "running" }); }) as typeof fetch);
    expect((await reopened.session("client-b", "session-one", "GET")).status).toBe(404);
    expect((await reopened.session("client-a", "session-one", "GET")).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toMatchObject({ max_acu_limit: 3 });
    expect(calls[1].url).toBe("https://api.devin.ai/v3/organizations/org-one/sessions/session-one");
    expect(calls[1].auth).toBe("Bearer synthetic-one");
  } finally { await f.close(); }
});

it("never retries ambiguous creation or leaks upstream error bodies", async () => {
  let calls = 0;
  const f = await fixture((async () => { calls++; return new Response("synthetic-one private upstream diagnostics", { status: 500 }); }) as typeof fetch);
  try {
    const response = await f.pool.create("client-a", { prompt: "test" });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("synthetic-one");
    expect(calls).toBe(1);
  } finally { await f.close(); }
});

it("enforces account ACU caps before calling Devin", async () => {
  let calls = 0;
  const f = await fixture((async () => { calls++; return Response.json({}); }) as typeof fetch);
  try {
    expect((await f.pool.create("client-a", { prompt: "test", account: "one", max_acu_limit: 6 })).status).toBe(400);
    expect(calls).toBe(0);
  } finally { await f.close(); }
});
