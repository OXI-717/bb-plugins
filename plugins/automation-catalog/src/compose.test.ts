import { it, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
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
it("spawns only on explicit submission and forwards composer selections", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "automation-catalog",
    sdk: { threads: { spawn: async () => ({ id: "thread_setup" }) } },
  });
  try {
    plugin(bb);
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
    expect(
      await harness.behavior.callRpc("catalog_compose", { request }),
    ).toEqual({ threadId: "thread_setup" });
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(harness.sdk.callsTo("threads.spawn")[0][0]).toMatchObject(request);
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
      }),
    ).rejects.toThrow();
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});
