import { it, expect } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
const request = {
  projectId: "proj_personal",
  providerId: "test-provider",
  model: "test-model",
  reasoningLevel: "low",
  permissionMode: "auto",
  executionInputSources: { model: "explicit" },
  environment: { type: "project-default" },
  input: [{ type: "text", text: "Create a daily report", mentions: [] }],
};
const parent = makeThreadResponse({ id: "thread_catalog", projectId: "proj_catalog", title: "Automation discussions", archivedAt: null });
const context = { title: "Разобрать · Daily report", parentThreadId: parent.id };
it("spawns only on explicit submission and forwards composer selections", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "automation-catalog",
    settings: { parentThreadId: parent.id },
    sdk: { threads: { get: async () => parent, spawn: async () => ({ id: "thread_setup" }) } },
  });
  try {
    plugin(bb);
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(
      await harness.behavior.callRpc("catalog_compose", { request, ...context }),
    ).toEqual({ threadId: "thread_setup" });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.spawn")[0][0]).toMatchObject(request);
    expect(harness.sdk.callsTo("threads.spawn")[0][0]).toMatchObject({ ...context, pluginMetadata: { kind: "automation-discussion", taskKey: null } });
    expect(await harness.behavior.callRpc("catalog_compose_context", {})).toEqual({ parentThreadId: parent.id, parentTitle: parent.title, projectId: parent.projectId });
  } finally {
    await harness.lifecycle.dispose();
  }
});
it("rejects an invalid request before attempting to spawn", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "automation-catalog",
  });
  try {
    plugin(bb);
    await expect(
      harness.behavior.callRpc("catalog_compose", {
        request: { ...request, permissionMode: "invalid" },
        ...context,
      }),
    ).rejects.toThrow();
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});
it.each(["missing", "archived", "changed"])("does not create orphan threads when parent is %s", async mode => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "automation-catalog",
    settings: { parentThreadId: mode === "missing" ? "" : parent.id },
    sdk: { threads: { get: async () => ({ ...parent, archivedAt: mode === "archived" ? Date.now() : null }) } },
  });
  try {
    plugin(bb);
    await expect(harness.behavior.callRpc("catalog_compose", { request, ...context, parentThreadId: mode === "changed" ? "old_parent" : parent.id })).rejects.toThrow();
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  } finally { await harness.lifecycle.dispose(); }
});
