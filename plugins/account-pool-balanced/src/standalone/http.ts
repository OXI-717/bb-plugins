import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PoolProvider } from "../contracts.js";
import { DEVIN_PROXIED_PATHS, devinMachineToken } from "../devin-adapter.js";
import type { StandalonePool } from "./runtime.js";

const routes = new Map<string, PoolProvider>([
  ["/v1/messages", "claude"], ["/v1/messages/count_tokens", "claude"],
  ["/v1/responses", "codex"], ["/v1/responses/compact", "codex"],
  ["/v1/models", "codex"], ["/v1/images/generations", "codex"], ["/v1/images/edits", "codex"], ["/v1/alpha/search", "codex"],
  ["/kimi/v1/messages", "kimi"], ["/kimi/v1/messages/count_tokens", "kimi"],
  ["/zai/v1/chat/completions", "zai"], ["/opencode-go/v1/chat/completions", "opencode-go"],
]);
for (const rpcPath of DEVIN_PROXIED_PATHS) {
  routes.set(`/devin/${rpcPath}`, "devin");
  routes.set(`/${rpcPath}`, "devin");
}
const MAX_BODY = 16 * 1024 * 1024;
class BodyTooLarge extends Error {}
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new BodyTooLarge();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function listenPool(pool: StandalonePool, options: { port: number; host?: string }) {
  // start() becomes accepting synchronously, then refreshes quotas in the background.
  let backgroundError = false;
  void pool.start().catch(() => { backgroundError = true; });
  const pending = new Set<Promise<void>>();
  const controllers = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    let finish = () => {};
    const completed = new Promise<void>(resolve => { finish = resolve; });
    pending.add(completed);
    res.once("close", () => { if (!res.writableFinished) controller.abort(); });
    const fail = (status: number, message: string) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: message }));
    };
    try {
      const url = new URL(req.url ?? "/", "http://pool.invalid");
      const provider = routes.get(url.pathname);
      const devinCreate = url.pathname === "/agents/devin/sessions" && req.method === "POST";
      const devinSession = /^\/agents\/devin\/sessions\/([A-Za-z0-9_-]{1,160})(\/messages)?$/.exec(url.pathname);
      const devinRoute = devinSession && (devinSession[2] ? req.method === "POST" : req.method === "GET" || req.method === "DELETE");
      const modelMethod = url.pathname === "/v1/models" ? "GET" : "POST";
      if ((!provider || req.method !== modelMethod) && !devinCreate && !devinRoute) { fail(404, "Unknown pool route."); return; }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      // Authenticate before buffering input, including Anthropic's x-api-key form.
      const credential = headers.get("x-bb-account-pool-token") ?? (provider === "devin" ? devinMachineToken(headers) : headers.get("authorization")?.replace(/^Bearer\s+/i, "")) ?? headers.get("x-api-key") ?? null;
      const client = await pool.tokens.authenticate(credential);
      if (client === null) { fail(401, "Invalid pool token."); return; }
      headers.set("x-bb-account-pool-token", credential!);
      if (backgroundError) { fail(503, "Pool service unavailable."); return; }
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY) { fail(413, "Request too large."); return; }
      const body = await readBody(req);
      if (devinCreate || devinRoute) {
        let input: unknown;
        try { input = body.length ? JSON.parse(body.toString("utf8")) : undefined; }
        catch { fail(400, "Invalid JSON."); return; }
        const response = devinCreate
          ? await pool.devin.create(client, input, controller.signal)
          : await pool.devin.session(client, devinSession![1], req.method as "GET" | "POST" | "DELETE", input, controller.signal);
        res.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(await response.text());
        return;
      }
      const request = new Request(url, { method: modelMethod, headers, body: modelMethod === "GET" ? undefined : body, signal: controller.signal });
      const response = await pool.hub.handle(request, provider!);
      const responseHeaders = Object.fromEntries(response.headers);
      responseHeaders["cache-control"] = "no-store";
      res.writeHead(response.status, responseHeaders);
      if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res);
      else res.end();
    } catch (error) {
      if (!res.headersSent && !res.destroyed) fail(error instanceof BodyTooLarge ? 413 : 502, error instanceof BodyTooLarge ? "Request too large." : "Pool request failed.");
      else res.destroy();
    } finally {
      controllers.delete(controller);
      pending.delete(completed);
      finish();
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as { port: number; address: string };
  return {
    url: `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`,
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const controller of controllers) controller.abort();
      server.closeAllConnections();
      await Promise.all(pending);
      await pool.close();
      await closed;
    },
  };
}
