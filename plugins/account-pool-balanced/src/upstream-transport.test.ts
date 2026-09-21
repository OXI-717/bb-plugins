import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import http from "node:http";
import http2 from "node:http2";
import { once } from "node:events";
import type { Dispatcher } from "undici";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";

const cleanups: Array<() => Promise<void>> = [];
const nativeFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubEnv("NO_PROXY", "*");
  vi.stubEnv("no_proxy", "*");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function upstream() {
  let requests = 0;
  const server = http.createServer(async (request, response) => {
    for await (const _chunk of request) {
    }
    requests++;
    response.end("OK");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  return { url: `http://127.0.0.1:${address.port}`, requests: () => requests };
}

it("uses an independent transport when the default dispatcher retains a destroyed HTTP/2 session", async () => {
  const cause = Object.assign(new Error("The session has been destroyed"), {
    code: "ERR_HTTP2_INVALID_SESSION",
  });
  const brokenDefault = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit & { dispatcher?: Dispatcher },
  ) => {
    if (init?.dispatcher === undefined) {
      throw new TypeError("fetch failed", { cause });
    }
    return nativeFetch(input, init);
  };
  vi.stubGlobal("fetch", brokenDefault);
  const target = await upstream();
  await expect(fetch(target.url)).rejects.toMatchObject({
    cause: {
      code: "ERR_HTTP2_INVALID_SESSION",
      message: "The session has been destroyed",
    },
  });
  expect(target.requests()).toBe(0);
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  for (let i = 0; i < 2; i++) {
    const response = await transport.fetch(target.url, {
      method: "POST",
      body: "hello",
    });
    expect(await response.text()).toBe("OK");
  }
  expect(target.requests()).toBe(2);
});

it("negotiates HTTP/1.1 when the upstream also offers HTTP/2", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pool-test-tls-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const cert = path.join(directory, "cert.pem");
  const key = path.join(directory, "key.pem");
  const config = path.join(directory, "openssl.cnf");
  await writeFile(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  await promisify(execFile)("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", key, "-out", cert, "-config", config,
  ], { timeout: 10_000 });
  const server = http2.createSecureServer({
    cert: await readFile(cert),
    key: await readFile(key),
    allowHTTP1: true,
  });
  let alpn: string | false | undefined;
  server.on("secureConnection", (socket) => {
    alpn = socket.alpnProtocol;
  });
  server.on("request", (request, response) => {
    response.end(JSON.stringify({ httpVersion: request.httpVersion, alpn }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  const moduleUrl = new URL("./upstream-transport.ts", import.meta.url);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
      import { createUpstreamTransport } from ${JSON.stringify(moduleUrl.href)};
      const transport = createUpstreamTransport();
      try {
        const response = await transport.fetch("https://127.0.0.1:${address.port}");
        console.log(await response.text());
      } finally {
        await transport.destroy();
      }
    `,
    ],
    {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: cert },
      timeout: 10_000,
    },
  );
  expect(JSON.parse(stdout)).toEqual({ httpVersion: "1.1", alpn: "http/1.1" });
}, 15_000);

it("releases its connections on disposal and refuses later requests", async () => {
  const target = await upstream();
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  expect(await (await transport.fetch(target.url)).text()).toBe("OK");
  await transport.destroy();
  await expect(transport.fetch(target.url)).rejects.toThrow();
  expect(target.requests()).toBe(1);
});

it("preserves cancellation without sending a request", async () => {
  const target = await upstream();
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  const controller = new AbortController();
  controller.abort();
  await expect(
    transport.fetch(target.url, { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(target.requests()).toBe(0);
});

it("does not replay an accepted POST whose response connection fails", async () => {
  let requests = 0;
  const server = http.createServer(async (request) => {
    for await (const _chunk of request) {
    }
    requests++;
    request.socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No port");
  const transport = createUpstreamTransport();
  cleanups.push(transport.destroy);
  await expect(
    transport.fetch(`http://127.0.0.1:${address.port}`, {
      method: "POST",
      body: "hello",
    }),
  ).rejects.toThrow();
  expect(requests).toBe(1);
});

it("does not expose arbitrary error messages or unrecognized codes", () => {
  const error = Object.assign(new Error("secret-token"), {
    code: "SECRET_TOKEN",
  });
  expect(transportErrorCode(error)).toBe("unclassified transport error");
  error.cause = error;
  expect(transportErrorCode(error)).toBe("unclassified transport error");
});
