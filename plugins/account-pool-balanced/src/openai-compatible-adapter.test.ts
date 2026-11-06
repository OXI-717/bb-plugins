import { describe, expect, it } from "vitest";
import { mountedUpstreamUrl } from "./provider-adapter.js";
import {
  createOpenAiCompatibleAdapter,
  isChatCompletionsBody,
  opencodeGoUpstreamPathSuffix,
  OPENCODE_GO_MOUNT_PREFIX,
  type OpenAiCompatibleAdapterOptions,
} from "./openai-compatible-adapter.js";
import { DEFAULT_ACCOUNT_POOL_CONFIG } from "./contracts.js";
import type { AccountSecret } from "./contracts.js";

const CHAT_BODY = new TextEncoder().encode(
  JSON.stringify({ model: "mimo-v2.6-pro", messages: [{ role: "user", content: "hi" }] }),
);
const RESPONSES_BODY = new TextEncoder().encode(
  JSON.stringify({
    model: "mimo-v2.6-pro",
    input: "hi",
    instructions: "be brief",
  }),
);
const AMBIGUOUS_BOTH = new TextEncoder().encode(
  JSON.stringify({ model: "mimo-v2.6-pro", messages: [], input: [] }),
);
const EMPTY_BODY = new TextEncoder().encode(JSON.stringify({}));
const NON_JSON_BODY = new TextEncoder().encode("not json");

const OP_ENCODE_GO_OPTIONS: OpenAiCompatibleAdapterOptions = {
  provider: "opencode-go",
  upstreamName: "OpenCode Go",
  mountPrefix: OPENCODE_GO_MOUNT_PREFIX,
  upstreamBaseUrl: () => "https://opencode.example/zen/go/v1",
  usagesUrl: "https://usages.example/usage",
  parseUsages: () => null,
  normalizeUpstreamPathSuffix: opencodeGoUpstreamPathSuffix,
};

function mountedRequest(suffix: string, search = ""): Request {
  return new Request(
    `https://hub.example/api/v1/plugins/account-pool/http/opencode-go/v1/${suffix}${search}`,
    { method: "POST" },
  );
}

function chatRewrite(path: string): string {
  return opencodeGoUpstreamPathSuffix(path, CHAT_BODY);
}

describe("opencode-go upstream path suffix normalization", () => {
  it("U1: rewrites inbound responses to upstream chat/completions", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("responses"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/chat/completions");
  });

  it("U2: leaves native chat/completions unchanged (no double rewrite)", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("chat/completions"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/chat/completions");
  });

  it("U3: leaves models unchanged", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("models"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/models");
  });

  it("U4: does not broadly rewrite responses/foo (exact match only)", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("responses/foo"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/responses/foo");
  });

  it("U5: does not rewrite Responses (case sensitive)", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("Responses"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/Responses");
  });

  it("U6: preserves the query string across the rewrite", () => {
    const url = mountedUpstreamUrl(
      mountedRequest("responses", "?stream=true&a=1&b=2"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      chatRewrite,
    );
    expect(url.toString()).toBe(
      "https://opencode.example/zen/go/v1/chat/completions?stream=true&a=1&b=2",
    );
  });

  it("U7: a genuine Responses body keeps the native /responses wire", () => {
    expect(opencodeGoUpstreamPathSuffix("responses", RESPONSES_BODY)).toBe("responses");
    expect(opencodeGoUpstreamPathSuffix("responses", AMBIGUOUS_BOTH)).toBe("responses");
    const url = mountedUpstreamUrl(
      mountedRequest("responses"),
      "https://opencode.example/zen/go/v1",
      `${OPENCODE_GO_MOUNT_PREFIX}v1/`,
      (path) => opencodeGoUpstreamPathSuffix(path, RESPONSES_BODY),
    );
    expect(url.toString()).toBe("https://opencode.example/zen/go/v1/responses");
  });

  it("U8: the messages wire passes through untouched", () => {
    expect(opencodeGoUpstreamPathSuffix("messages", RESPONSES_BODY)).toBe("messages");
    expect(opencodeGoUpstreamPathSuffix("messages", CHAT_BODY)).toBe("messages");
  });

  it("opencodeGoUpstreamPathSuffix is identity outside responses", () => {
    expect(chatRewrite("chat/completions")).toBe("chat/completions");
    expect(chatRewrite("models")).toBe("models");
    expect(chatRewrite("")).toBe("");
    expect(chatRewrite("responses/v2")).toBe("responses/v2");
  });
});

describe("isChatCompletionsBody (fail closed)", () => {
  it("U7: accepts a messages[] body", () => {
    expect(isChatCompletionsBody(CHAT_BODY)).toBe(true);
  });

  it("U8: rejects a Responses body (input/instructions)", () => {
    expect(isChatCompletionsBody(RESPONSES_BODY)).toBe(false);
  });

  it("U9: rejects an ambiguous body carrying both markers", () => {
    expect(isChatCompletionsBody(AMBIGUOUS_BOTH)).toBe(false);
  });

  it("U10: rejects empty object and non-JSON", () => {
    expect(isChatCompletionsBody(EMPTY_BODY)).toBe(false);
    expect(isChatCompletionsBody(NON_JSON_BODY)).toBe(false);
  });
});


describe("opencode-go adapter wire routing", () => {
  const secret: AccountSecret = { kind: "api-key", apiKey: "sk-go-subscription" };

  it("U15: wires no body guard — genuine Responses traffic is legal", () => {
    const adapter = createOpenAiCompatibleAdapter(OP_ENCODE_GO_OPTIONS);
    expect(adapter.guardRequest).toBeUndefined();
  });

  it("U16: upstreamUrl picks the wire by body shape", () => {
    const adapter = createOpenAiCompatibleAdapter(OP_ENCODE_GO_OPTIONS);
    const settings = {
      ...DEFAULT_ACCOUNT_POOL_CONFIG,
      opencodeGoUpstreamBaseUrl: "https://opencode.example/zen/go/v1",
    };
    // Chat body on /responses is still corrected onto /chat/completions.
    expect(
      adapter.upstreamUrl(mountedRequest("responses"), settings, CHAT_BODY).toString(),
    ).toBe("https://opencode.example/zen/go/v1/chat/completions");
    // A genuine Responses body keeps the native /responses wire.
    expect(
      adapter.upstreamUrl(mountedRequest("responses"), settings, RESPONSES_BODY).toString(),
    ).toBe("https://opencode.example/zen/go/v1/responses");
    // Anthropic Messages wire passes through untouched.
    expect(
      adapter.upstreamUrl(mountedRequest("messages"), settings, RESPONSES_BODY).toString(),
    ).toBe("https://opencode.example/zen/go/v1/messages");
    expect(
      adapter.upstreamUrl(mountedRequest("chat/completions"), settings, CHAT_BODY).toString(),
    ).toBe("https://opencode.example/zen/go/v1/chat/completions");
    void secret;
  });

  it("U18: zai adapter leaves /responses untouched and implements no guard", () => {
    const zai = createOpenAiCompatibleAdapter({
      provider: "zai",
      upstreamName: "Z.ai Coding Plan",
      mountPrefix: "zai/",
      upstreamBaseUrl: () => "https://api.z.example/api/coding/paas/v4",
      usagesUrl: "https://usages.example/zai",
      parseUsages: () => null,
    });
    expect(zai.guardRequest).toBeUndefined();
    const settings = {
      ...DEFAULT_ACCOUNT_POOL_CONFIG,
      zaiUpstreamBaseUrl: "https://api.z.example/api/coding/paas/v4",
    };
    const request = new Request(
      "https://hub.example/api/v1/plugins/account-pool/http/zai/v1/responses",
      { method: "POST" },
    );
    expect(zai.upstreamUrl(request, settings).toString()).toBe(
      "https://api.z.example/api/coding/paas/v4/responses",
    );
  });
});
