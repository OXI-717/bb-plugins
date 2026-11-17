import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin, { importNativePreferences } from "./server.js";
import { defaultPreferences } from "./shared/preferences.js";

function setup(preferences: unknown) {
  const callRpc = vi.fn(async () => ({ preferences }));
  return { ...createFakePluginHost({ pluginId: "oxi-thread-list", sdk: { plugins: { callRpc } } }), callRpc };
}

describe("native list preference import", () => {
  it("preserves collapse, sorting, visibility and actions without writing back to the native plugin", async () => {
    const source = { ...defaultPreferences(), organizationMode: "project", collapsedThreads: ["parent"],
      collapsedProjects: ["p"], hiddenGroups: ["project:hidden"], rowActions: ["bb--core/pin"],
      projectMachineGrouping: false };
    const copy = structuredClone(source);
    const { bb, harness, callRpc } = setup(source);
    await plugin(bb);
    const result = await harness.behavior.callRpc("listPreferences", null) as { preferences: unknown };
    expect(result.preferences).toMatchObject({ ...source, projectMachineGrouping: true });
    expect(callRpc).toHaveBeenCalledOnce();
    expect(callRpc.mock.calls[0]).toMatchObject([{ pluginId: "thread-list", method: "listPreferences", input: null }]);
    expect(source).toEqual(copy);
    await bb.storage.kv.set("preference:collapsedThreads", ["mine"]);
    await importNativePreferences(bb);
    expect(callRpc).toHaveBeenCalledOnce();
    expect(await bb.storage.kv.get("preference:collapsedThreads")).toEqual(["mine"]);
  });
  it("validates all values before writing anything and allows a clean retry", async () => {
    const source = { ...defaultPreferences(), organizationMode: "project", collapsedProjects: 123 };
    const { bb, callRpc } = setup(source);
    await expect(importNativePreferences(bb)).rejects.toThrow("collapsedProjects");
    expect(await bb.storage.kv.get("preference:organizationMode")).toBeUndefined();
    expect(await bb.storage.kv.get("migration:native-thread-list:v1")).toBeUndefined();
    callRpc.mockResolvedValue({ preferences: defaultPreferences() });
    await importNativePreferences(bb);
    expect(await bb.storage.kv.get("migration:native-thread-list:v1")).toBe(true);
  });
  it("fails closed when the bundled provider is unavailable or returns an incomplete response", async () => {
    const { bb, callRpc } = setup({});
    await expect(plugin(bb)).rejects.toThrow("missing");
    callRpc.mockRejectedValue(new Error("unavailable"));
    await expect(plugin(bb)).rejects.toThrow("unavailable");
    expect(await bb.storage.kv.get("migration:native-thread-list:v1")).toBeUndefined();
  });
  it("never overwrites preferences already customized in this provider", async () => {
    const { bb } = setup({ ...defaultPreferences(), collapsedThreads: ["source"] });
    await bb.storage.kv.set("preference:collapsedThreads", ["mine"]);
    await importNativePreferences(bb);
    expect(await bb.storage.kv.get("preference:collapsedThreads")).toEqual(["mine"]);
  });
});
