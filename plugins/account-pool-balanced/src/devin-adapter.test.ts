import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { createDevinAdapter, devinMachineToken, replaceDevinKey, rewriteDevinBody } from "./devin-adapter.js";

const bytes = (text: string) => new TextEncoder().encode(text);
function field(number: number, data: Uint8Array): Uint8Array {
  if (data.length > 127) throw new Error("Test field too large.");
  const tag = number * 8 + 2;
  return Uint8Array.of(...(tag < 128 ? [tag] : [(tag & 127) | 128, tag >> 7]), data.length, ...data);
}
function frame(data: Uint8Array, compressed = false): Uint8Array {
  const payload = compressed ? gzipSync(data) : data;
  const header = new Uint8Array(5);
  header[0] = compressed ? 1 : 0;
  new DataView(header.buffer).setUint32(1, payload.length);
  return Uint8Array.of(...header, ...payload);
}

describe("Devin CLI protobuf proxy", () => {
  const original = Uint8Array.of(...field(1, Uint8Array.of(...field(3, bytes("client-token")), ...field(10, bytes("session-one")))), ...field(21, bytes("swe-2-high")));

  it("replaces only metadata.apiKey and preserves unknown fields", () => {
    const result = replaceDevinKey(original, "account-pat");
    expect(Buffer.from(result).includes(Buffer.from(bytes("account-pat")))).toBe(true);
    expect(Buffer.from(result).includes(Buffer.from(bytes("client-token")))).toBe(false);
    expect(Buffer.from(result).includes(Buffer.from(bytes("session-one")))).toBe(true);
    expect(Buffer.from(result).includes(Buffer.from(bytes("swe-2-high")))).toBe(true);
  });

  it("rewrites gzip Connect frames and keeps trailer bytes", () => {
    const trailer = frame(bytes('{"code":"ok"}'));
    trailer[0] = 2;
    const output = rewriteDevinBody(Uint8Array.of(...frame(original, true), ...trailer), "application/connect+proto", "account-pat");
    const length = new DataView(output.buffer, output.byteOffset + 1, 4).getUint32(0);
    const payload = gunzipSync(output.subarray(5, 5 + length));
    expect(Buffer.from(payload).includes(Buffer.from(bytes("account-pat")))).toBe(true);
    expect(output.subarray(5 + length)).toEqual(trailer);
  });

  it("preserves a 64-bit protobuf varint beside the key", () => {
    const body = Uint8Array.of(...original, 0x28, ...Array(9).fill(0xff), 0x01);
    const rewritten = replaceDevinKey(body, "account-pat");
    expect(rewritten.subarray(-11)).toEqual(body.subarray(-11));
  });

  it("rewrites a gzip-compressed unary protobuf request", () => {
    const output = rewriteDevinBody(gzipSync(original), "application/proto", "account-pat", "gzip");
    const decoded = gunzipSync(output);
    expect(Buffer.from(decoded).includes(Buffer.from(bytes("account-pat")))).toBe(true);
    expect(Buffer.from(decoded).includes(Buffer.from(bytes("client-token")))).toBe(false);
  });

  it("uses the selected PAT in both body and HTTP authorization", () => {
    const adapter = createDevinAdapter();
    const secret = { kind: "api-key" as const, apiKey: "account-pat" };
    const headers = new Headers({ authorization: "Basic client-token", "content-type": "application/proto" });
    const parsed = adapter.parseRequest(original, headers);
    expect(Buffer.from(parsed.forAccount({} as never, secret)).includes(Buffer.from(bytes("account-pat")))).toBe(true);
    const upstream = adapter.requestHeaders(headers, {} as never, secret);
    expect(upstream.get("authorization")).toBe("Basic account-pat");
    expect(adapter.inboundToken?.(headers)).toBe("client-token");
    expect(devinMachineToken(new Headers({ authorization: `Basic client-token-${"x".repeat(43)}` }))).toBe("client-token");
  });
});
