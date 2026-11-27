// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

// Route the real app.tsx through the preview shim, exactly like the esbuild
// alias in preview/build.mjs, so this test exercises the real registration
// loop and the real icon components the served page draws.
vi.mock("@get-bb/plugin-sdk/app", async () => await import("./preview/sdk.js"));

describe("preview page", () => {
  it("renders the seven registered marks plus host fallbacks", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    await import("./preview/main.js");
    // Let the root commit its initial render.
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 7 picker rows + 7 usage rows + 11 control cards with two marks each.
    expect(document.querySelectorAll("svg").length).toBe(7 + 7 + 11 * 2);
    expect(document.querySelectorAll(".badge.registered").length).toBe(7);
    expect(document.querySelectorAll(".badge:not(.registered)").length).toBe(4);
    expect(document.querySelector(".toolbar")).not.toBeNull();
    expect(document.querySelectorAll('[role="option"]').length).toBe(7);
  });
});
