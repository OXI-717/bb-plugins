// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// Route the real app.tsx through the preview shim, exactly like the esbuild
// alias in preview/build.mjs, so this test exercises the real registration
// loop and the real mark components the served page draws.
vi.mock("@get-bb/plugin-sdk/app", async () => await import("./preview/sdk.js"));

const REGISTERED_IDS = [
  "acp-agy",
  "acp-opencode-kimi",
  "acp-oxi-cursor",
  "acp-oxi-devin-pool",
  "acp-opencode-go",
  "acp-opencode-zai",
  "acp-opencode-neuraldeep",
];

const FALLBACK_IDS = ["codex", "claude-code", "acp-cursor", "acp-demo-unknown"];

describe("preview page: native model-picker replica", () => {
  it("renders the native drawer with eleven provider buttons", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("./preview/main.js");
    // Let the root commit its initial render.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const drawer = document.querySelector('[data-fixture="provider-drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.className).toContain("min-w-auto");
    expect(drawer?.className).toContain("max-w-auto");

    const row = document.querySelector('[data-fixture="provider-row"]');
    expect(row?.className).toContain("drawer-row");

    const buttons = drawer?.querySelectorAll("button[data-provider-id]");
    expect(buttons?.length).toBe(11);
    for (const id of [...REGISTERED_IDS, ...FALLBACK_IDS]) {
      expect(
        drawer?.querySelector(`button[data-provider-id="${id}"]`),
        `${id} button missing`,
      ).not.toBeNull();
    }

    // The eleven usage rows mirror the same provider set.
    const usageRows = document.querySelectorAll(
      ".usage-row[data-provider-id]",
    );
    expect(usageRows.length).toBe(11);
  });

  it("renders the seven registered marks as mask spans, fallbacks as host svgs", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("./preview/main.js");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const wraps = document.querySelectorAll(
      '[data-fixture="icon-wrap"], [data-fixture="usage-wrap"]',
    );
    expect(wraps.length).toBe(22);
    let maskSpans = 0;
    let hostGlyphs = 0;
    for (const wrap of wraps) {
      const mark = wrap.firstElementChild;
      expect(mark, "wrapper must contain the mark child").not.toBeNull();
      if (mark!.tagName.toLowerCase() === "span") {
        const style = mark!.getAttribute("style") ?? "";
        expect(style).toContain("mask-image");
        expect(style).toContain("-webkit-mask-image");
        expect(style).toContain("pointer-events");
        expect(mark!.getAttribute("class")).toBe("size-full");
        maskSpans += 1;
      } else {
        expect(mark!.tagName.toLowerCase()).toBe("svg");
        hostGlyphs += 1;
      }
    }
    expect(maskSpans).toBe(7 * 2);
    expect(hostGlyphs).toBe(4 * 2);
  });

  it("records the tapped provider id and toggles selection", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("./preview/main.js");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const status = () =>
      document.querySelector("[data-selected-id]")?.getAttribute("data-selected-id");
    expect(status()).toBe("none");

    const target = document.querySelector(
      'button[data-provider-id="acp-opencode-zai"]',
    );
    target?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status()).toBe("acp-opencode-zai");
    expect(
      document
        .querySelector('button[data-provider-id="acp-opencode-zai"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true");

    const fallback = document.querySelector(
      'button[data-provider-id="codex"]',
    );
    fallback?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status()).toBe("codex");
  });

  it("keeps the preview toolbar", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("./preview/main.js");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.querySelector(".toolbar")).not.toBeNull();
  });
});
