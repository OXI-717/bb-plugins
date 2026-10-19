import { expect, it, vi } from "vitest";
import { describeTransportError, observeUpstreamFetch } from "./transport-diagnostics.js";
import { NetworkFlights } from "./network-flights.js";

it.each([
  ["ENOTFOUND", "dns"], ["EAI_AGAIN", "dns"],
  ["UND_ERR_CONNECT_TIMEOUT", "connect"], ["ECONNREFUSED", "connect"],
  ["ECONNRESET", "socket"], ["UND_ERR_SOCKET", "socket"],
  ["ERR_TLS_CERT_ALTNAME_INVALID", "tls"], ["CERT_HAS_EXPIRED", "tls"],
  ["UND_ERR_HEADERS_TIMEOUT", "headers"], ["UND_ERR_BODY_TIMEOUT", "body"],
  ["ERR_HTTP2_INVALID_SESSION", "session"], ["ABORT_ERR", "abort"],
])("classifies the safe cause code %s", (code, category) => {
  const cause = Object.assign(new Error("secret request URL"), { code });
  expect(describeTransportError(new TypeError("secret", { cause }))).toEqual({ code, category });
});

it("finds a known cause inside a bounded AggregateError", () => {
  expect(describeTransportError(new AggregateError([
    new Error("private"), Object.assign(new Error("private"), { code: "ECONNREFUSED" }),
  ]))).toEqual({ code: "ECONNREFUSED", category: "connect" });
});

it("never emits unknown names, messages, codes or circular data", () => {
  const error = Object.assign(new Error("https://private.example/token?secret=abc"), { code: "SECRET", name: "SECRET" });
  error.cause = error;
  expect(describeTransportError(error)).toEqual({ code: "unknown", category: "unknown" });
  expect(describeTransportError(new DOMException("private", "AbortError"))).toEqual({ code: "ABORT_ERR", category: "abort" });
});

it("measures only the fetch attempt and preserves the rejection", async () => {
  const error = Object.assign(new Error("private"), { code: "ECONNRESET" });
  const onError = vi.fn();
  const clock = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(123.8);
  const observed = observeUpstreamFetch(async () => { throw error; }, onError, clock);
  await expect(observed("https://synthetic.example")).rejects.toBe(error);
  expect(onError).toHaveBeenCalledExactlyOnceWith(error, 23);
});

it("does not report a cancellation from the owner", async () => {
  const controller = new AbortController();
  const error = new Error("private");
  const onError = vi.fn();
  const observed = observeUpstreamFetch(async () => { controller.abort(); throw error; }, onError);
  await expect(observed("https://synthetic.example", { signal: controller.signal })).rejects.toBe(error);
  expect(onError).not.toHaveBeenCalled();
});

it("diagnostics cannot replace an upstream result or error", async () => {
  const onError = () => { throw new Error("logger failed"); };
  const error = new Error("upstream failed");
  await expect(observeUpstreamFetch(async () => { throw error; }, onError)("https://synthetic.example")).rejects.toBe(error);
  const response = new Response("OK");
  expect(await observeUpstreamFetch(async () => response, onError)("https://synthetic.example")).toBe(response);
});

it("bounds cause traversal and tolerates throwing error accessors", () => {
  let error: Error = Object.assign(new Error("private"), { code: "ECONNRESET" });
  for (let index = 0; index < 20; index++) error = new Error("private", { cause: error });
  expect(describeTransportError(error)).toEqual({ code: "unknown", category: "unknown" });
  Object.defineProperty(error, "code", { get() { throw new Error("private"); } });
  expect(describeTransportError(error)).toEqual({ code: "unknown", category: "unknown" });
});

it("does not log admission or post-response policy failures", async () => {
  let allowed = false;
  const onError = vi.fn();
  const stop = new AbortController();
  const flights = new NetworkFlights(fetch, () => stop.signal, async () => {
    if (!allowed) throw new Error("policy denied");
  }, () => observeUpstreamFetch(async () => {
    allowed = false;
    return new Response("OK");
  }, onError));
  await expect(flights.fetch("codex", "https://synthetic.example")).rejects.toThrow("policy denied");
  allowed = true;
  await expect(flights.fetch("codex", "https://synthetic.example")).rejects.toThrow("policy denied");
  expect(onError).not.toHaveBeenCalled();
  expect(flights.size).toBe(0);
});

it("identifies model and auxiliary attempts without exposing the request", async () => {
  const selected = vi.fn(() => observeUpstreamFetch(async () => { throw new Error("offline"); }, () => {}));
  const stop = new AbortController();
  const flights = new NetworkFlights(fetch, () => stop.signal, async () => {}, selected);
  await expect(flights.fetch("codex", "https://synthetic.example", {}, true)).rejects.toThrow("offline");
  await expect(flights.fetch("codex", "https://synthetic.example")).rejects.toThrow("offline");
  expect(selected.mock.calls).toEqual([["codex", true], ["codex", false]]);
});
