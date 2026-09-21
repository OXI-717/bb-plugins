import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { PoolKvStorage } from "../core-storage.js";

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
const accountSchema = z.object({ id: identifier, organizationId: identifier, maxAcuLimit: z.number().positive().finite() }).strict();
const importSchema = accountSchema.extend({ apiKey: z.string().min(1).max(8192) });
const createSchema = z.object({ prompt: z.string().min(1).max(100_000), account: identifier.optional(), max_acu_limit: z.number().positive().finite().optional(), title: z.string().max(500).optional() }).strict();
const bindingSchema = z.object({ account: identifier, session: identifier }).strict();
const error = (status: number, message: string) => Response.json({ error: message }, { status });

/** Cloud sessions have durable ownership; never fail over an existing session. */
export class DevinPool {
  private next = 0;
  constructor(private readonly kv: PoolKvStorage, private readonly secretDir: string, private readonly fetcher: typeof fetch = fetch) {}

  async add(input: unknown) {
    const value = importSchema.parse(input);
    await fs.mkdir(this.secretDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.secretDir, 0o700);
    const file = path.join(this.secretDir, `${value.id}.json`);
    await fs.writeFile(file, JSON.stringify({ apiKey: value.apiKey }), { flag: "wx", mode: 0o600 });
    const { apiKey: _key, ...metadata } = value;
    try { await this.kv.set(`devin-account:${value.id}`, metadata); }
    catch (cause) { await fs.rm(file); throw cause; }
    return metadata;
  }

  async create(client: string, input: unknown, signal?: AbortSignal): Promise<Response> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) return error(400, "Invalid Devin session request.");
    const accounts = await this.accounts();
    const account = parsed.data.account ? accounts.find(a => a.id === parsed.data.account) : accounts.length ? accounts[this.next++ % accounts.length] : undefined;
    if (!account) return error(503, "No matching Devin account configured.");
    const limit = parsed.data.max_acu_limit ?? account.maxAcuLimit;
    if (limit > account.maxAcuLimit) return error(400, "Requested ACU limit exceeds the account's session cap.");
    const response = await this.request(account, "", "POST", { prompt: parsed.data.prompt, title: parsed.data.title, max_acu_limit: limit }, signal);
    if (!response.ok) return response;
    const payload: unknown = await response.json();
    const session = z.object({ session_id: identifier }).safeParse(payload);
    if (!session.success) return error(502, "Devin returned an invalid session. Check Devin before retrying creation.");
    await this.kv.set(this.bindingKey(client, session.data.session_id), { account: account.id, session: session.data.session_id });
    return Response.json(payload);
  }

  async session(client: string, sessionId: string, method: "GET" | "POST" | "DELETE", input?: unknown, signal?: AbortSignal): Promise<Response> {
    if (!identifier.safeParse(sessionId).success) return error(404, "Unknown Devin session.");
    const saved = await this.kv.get(this.bindingKey(client, sessionId));
    if (saved === undefined) return error(404, "Unknown Devin session.");
    const binding = bindingSchema.parse(saved);
    const account = (await this.accounts()).find(a => a.id === binding.account);
    if (!account) return error(503, "Session account is unavailable.");
    let message: { message: string } | undefined;
    if (method === "POST") {
      const parsed = z.object({ message: z.string().min(1).max(100_000) }).strict().safeParse(input);
      if (!parsed.success) return error(400, "Invalid Devin message.");
      message = parsed.data;
    }
    return this.request(account, `/${binding.session}${method === "POST" ? "/messages" : ""}`, method, message, signal);
  }

  private bindingKey(client: string, session: string) { return `devin-session:${JSON.stringify([client, session])}`; }
  private async accounts() {
    const keys = await this.kv.list("devin-account:");
    return Promise.all(keys.map(async key => accountSchema.parse(await this.kv.get(key))));
  }

  private async request(account: z.infer<typeof accountSchema>, suffix: string, method: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    try {
      const { apiKey } = z.object({ apiKey: z.string().min(1) }).strict().parse(JSON.parse(await fs.readFile(path.join(this.secretDir, `${account.id}.json`), "utf8")));
      const response = await this.fetcher(`https://api.devin.ai/v3/organizations/${account.organizationId}/sessions${suffix}`, {
        method, headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return error(response.status === 429 ? 429 : 502, `Devin returned HTTP ${response.status}. No automatic retry was attempted.`);
      }
      // Bound the upstream response as well as incoming prompts.
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > 2 * 1024 * 1024) { await reader.cancel(); return error(502, "Devin response too large."); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      if (!size) return Response.json({ ok: true });
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return Response.json(payload);
    } catch {
      return error(502, "Devin request failed; its outcome may be unknown. Check Devin before retrying. No automatic retry was attempted.");
    }
  }
}
