import { describe, expect, it, vi } from "vitest";
import { apiKeyFailure } from "./api-key-errors.js";

describe("bounded API-key rejection classification", () => {
  it.each([401, 403])("recognizes expired key at %s without storing provider text", async status => {
    const result = await apiKeyFailure(Response.json({error:{code:"api_key_expired",message:"synthetic-private-value"}}, {status}));
    expect(result?.expired).toBe(true);
    expect(result?.accountMessage).toContain("API_KEY_EXPIRED");
    expect(result?.accountMessage).not.toContain("synthetic-private-value");
    expect(result?.accountMessage).not.toContain("Sign in again");
  });
  it.each([400, 403, 429, 500, 502, 503])("does not invalidate credentials for ambiguous HTTP %s", async status => {
    expect(await apiKeyFailure(Response.json({error:{message:"temporary failure"}}, {status}))).toBeNull();
  });
  it("does not trust an expired code on a server failure", async () => {
    expect(await apiKeyFailure(Response.json({error:{code:"api_key_expired"}}, {status:503}))).toBeNull();
  });
  it.each(["invalid_api_key", "api_key_revoked"])("recognizes explicit %s at 403", async code => {
    expect((await apiKeyFailure(Response.json({error:{code}}, {status:403})))?.expired).toBe(false);
  });
  it("bounds error bytes", async () => {
    const result = await apiKeyFailure(Response.json({padding:"x".repeat(8192),error:{code:"api_key_expired"}}, {status:403}));
    expect(result).toBeNull();
  });
  it("fails safely on malformed JSON and HTML", async () => {
    expect(await apiKeyFailure(new Response("{broken", {status:403,headers:{"content-type":"application/json"}}))).toBeNull();
    expect((await apiKeyFailure(new Response("<html>private</html>", {status:401})))?.expired).toBe(false);
  });
  it("does not hang on an unending error body", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const pending = apiKeyFailure(new Response(new ReadableStream({cancel}), {status:403,headers:{"content-type":"application/json"}}));
      await vi.advanceTimersByTimeAsync(2001);
      expect(await pending).toBeNull();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});
