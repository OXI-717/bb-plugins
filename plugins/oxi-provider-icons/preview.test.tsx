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

const BUILTIN_IDS = ["codex", "claude-code", "acp-cursor"];
const UNKNOWN_IDS = ["acp-demo-unknown"];

describe("preview page: live-DOM model-picker replica", () => {
  it("renders the drawer with the host markup and eleven provider tabs", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("./preview/main.js");
    // Let the root commit its initial render.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const drawer = document.querySelector('[data-fixture="provider-drawer"]');
    expect(drawer).not.toBeNull();
    for (const cls of [
      "flex",
      "min-h-0",
      "flex-col",
      "p-0",
      "w-max",
      "min-w-64",
      "max-w-80",
      "flex-1",
      "overflow-y-hidden",
    ]) {
      expect(drawer?.className, `drawer must carry ${cls}`).toContain(cls);
    }
    const drawerStyle = (drawer?.getAttribute("style") ?? "").replace(/\s/g, "");
    expect(drawerStyle).toContain("width:auto");
    expect(drawerStyle).toContain("min-width:auto");
    expect(drawerStyle).toContain("max-width:none");

    const row = document.querySelector('[data-fixture="provider-row"]');
    for (const cls of [
      "flex",
      "shrink-0",
      "items-center",
      "gap-0.5",
      "border-b",
      "border-border",
      "bg-background",
      "px-2.5",
      "pt-1",
    ]) {
      expect(row?.className, `tabs row must carry ${cls}`).toContain(cls);
    }

    const buttons = drawer?.querySelectorAll("button[data-provider-id]");
    expect(buttons?.length).toBe(11);
    for (const id of [...REGISTERED_IDS, ...BUILTIN_IDS, ...UNKNOWN_IDS]) {
      expect(
        drawer?.querySelector(`button[data-provider-id="${id}"]`),
        `${id} tab missing`,
      ).not.toBeNull();
    }
    for (const button of buttons ?? []) {
      for (const cls of [
        "h-7",
        "w-6",
        "max-md:pointer-coarse:h-9",
        "max-md:pointer-coarse:w-9",
        "border-b-2",
        "border-transparent",
        "text-muted-foreground",
      ]) {
        expect(button.className, `${button.id} tab must carry ${cls}`).toContain(cls);
      }
    }
  });

  it("renders the core icon wrapper with the live geometry classes", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("./preview/main.js");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const wraps = document.querySelectorAll('[data-fixture="icon-wrap"]');
    expect(wraps.length).toBe(11);
    for (const wrap of wraps) {
      for (const cls of [
        "inline-flex",
        "min-h-max",
        "min-w-max",
        "shrink-0",
        "items-center",
        "justify-center",
        "size-4",
        "max-md:pointer-coarse:size-5",
      ]) {
        expect(wrap.className, `icon wrapper must carry ${cls}`).toContain(cls);
      }
      expect(wrap.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("renders registered mask spans, builtin bg-current mask spans, Lucide fallback", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("./preview/main.js");
    await new Promise((resolve) => setTimeout(resolve, 100));

    const counts = { registered: 0, builtin: 0, unknown: 0 };
    for (const wrap of document.querySelectorAll('[data-fixture="icon-wrap"]')) {
      const mark = wrap.firstElementChild;
      expect(mark, "wrapper must contain the mark child").not.toBeNull();
      const id = wrap.closest("button")?.getAttribute("data-provider-id") ?? "";
      const style = mark!.getAttribute("style") ?? "";
      if (REGISTERED_IDS.includes(id)) {
        expect(mark!.tagName.toLowerCase(), `${id} mark must be our span`).toBe("span");
        expect(mark!.getAttribute("class")).toBe("size-full");
        expect(style).toContain("mask-image");
        expect(style).toContain("-webkit-mask-image");
        expect(style).toContain("pointer-events");
        counts.registered += 1;
      } else if (BUILTIN_IDS.includes(id)) {
        expect(mark!.tagName.toLowerCase(), `${id} builtin mark must be a span`).toBe("span");
        expect(mark!.className, `${id} builtin classes`).toContain("inline-block");
        expect(mark!.className).toContain("bg-current");
        expect(mark!.className).toContain("size-full");
        expect(mark!.className).toContain("shrink-0");
        expect(style).toContain("mask-image");
        expect(style).toContain("-webkit-mask-image");
        expect(style).toContain("mask-repeat");
        counts.builtin += 1;
      } else {
        expect(mark!.tagName.toLowerCase(), `${id} fallback must be a Lucide svg`).toBe("svg");
        expect(mark!.getAttribute("width")).toBe("24");
        expect(mark!.getAttribute("height")).toBe("24");
        expect(mark!.getAttribute("viewBox")).toBe("0 0 24 24");
        expect(mark!.getAttribute("class")).toBe("size-full");
        counts.unknown += 1;
      }
    }
    expect(counts).toEqual({ registered: 7, builtin: 3, unknown: 1 });

    // Usage header mirrors the same provider set through size-6 wrappers.
    const usageWraps = document.querySelectorAll('[data-fixture="usage-wrap"]');
    expect(usageWraps.length).toBe(11);
    for (const wrap of usageWraps) {
      expect(wrap.className).toContain("size-6");
      expect(wrap.className).toContain("min-w-max");
    }
  });

  it("records the tapped provider id and toggles the tab", async () => {
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

    const builtin = document.querySelector('button[data-provider-id="codex"]');
    builtin?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status()).toBe("codex");

    const unknown = document.querySelector(
      'button[data-provider-id="acp-demo-unknown"]',
    );
    unknown?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(status()).toBe("acp-demo-unknown");
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
