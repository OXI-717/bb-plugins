import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  makeHostResponse,
} from "@get-bb/plugin-sdk/testing";
import { randomUUID } from "node:crypto";
import plugin from "./server";
import { z } from "zod";
import { catalogOutput } from "./contract";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanups.splice(0)) await dispose();
});
async function setup() {
  const fake = createFakePluginHost({ pluginId: "model-connections" });
  cleanups.push(() => fake.harness.lifecycle.dispose());
  const { harness } = fake;
  let pooled = true;
  let bypassed = false;
  harness.sdk.stub("hosts.list", async () => [
    makeHostResponse({ id: "host-one", name: "Test machine" }),
  ]);
  harness.sdk.stub("threads.get", async () =>
    makeThreadResponse({
      id: "thread-one",
      projectId: "project-one",
      environmentId: "environment-one",
      providerId: "codex",
      status: "active",
    }),
  );
  harness.sdk.stub("environments.get", async () => ({
    id: "environment-one",
    hostId: "host-one",
  }));
  harness.sdk.stub("providers.list", async () => [
    {
      id: "codex",
      displayName: "Codex",
      available: true,
      logoUrl: null,
      icon: { glyph: "Bot" },
    },
    {
      id: "pi",
      displayName: "Pi",
      available: true,
      logoUrl: null,
      icon: { glyph: "Bot" },
    },
  ]);
  harness.sdk.stub("system.providerStates", async () => ({
    providers: [
      { providerId: "codex", status: "ready" },
      { providerId: "pi", status: "not_installed" },
    ],
  }));
  harness.sdk.stub("plugins.callRpc", async (...raw: unknown[]) => {
    const args = z
      .object({
        pluginId: z.literal("account-pool-balanced"),
        method: z.enum(["thread.account", "status.get"]),
      })
      .parse(raw[0]);
    if (args.method === "thread.account")
      return { state: bypassed ? "bypassed" : "unobserved" };
    return {
      routing: {
        codex: pooled,
        claude: true,
        cursor: true,
        devin: true,
        kimi: true,
        zai: true,
        "opencode-go": true,
      },
      accounts: [{ provider: "codex", enabled: true }],
    };
  });
  harness.sdk.stub("threads.update", async () => ({ ok: true }));
  harness.sdk.stub("threads.spawn", async () =>
    makeThreadResponse({ id: "thread-created" }),
  );
  await plugin(fake.bb);
  return {
    ...fake,
    setPooled: (value: boolean) => {
      pooled = value;
    },
    setBypassed: (value: boolean) => {
      bypassed = value;
    },
  };
}
const apply = {
  threadId: "thread-one",
  providerId: "codex",
  model: "model-one",
  reasoningLevel: "medium",
  expectedGroup: "pool",
};
const create = () => ({
  requestId: randomUUID(),
  expectedProviderId: "codex",
  expectedGroup: "pool",
  sourceThreadId: "thread-one",
  request: {
    projectId: "project-one",
    providerId: "codex",
    model: "model-one",
    reasoningLevel: "medium",
    permissionMode: "auto",
    executionInputSources: {
      providerId: "explicit",
      model: "explicit",
      reasoningLevel: "explicit",
    },
    environment: { type: "reuse", environmentId: "environment-one" },
    input: [{ type: "text", text: "Continue the work", mentions: [] }],
  },
});
describe("model connections RPC", () => {
  it("routes discovery by the thread environment and reports confirmed missing CLI", async () => {
    const f = await setup();
    const data = catalogOutput.parse(
      await f.harness.behavior.callRpc("catalog", { threadId: "thread-one" }),
    );
    expect(data).toMatchObject({
      hostId: "host-one",
      environmentId: "environment-one",
    });
    expect(
      data.connections.find((r: { id: string }) => r.id === "pi"),
    ).toMatchObject({ selectable: false, detail: "Не установлен" });
    expect(
      f.harness.inspection.sdk.callsTo("providers.list")[0][0],
    ).toMatchObject({ environmentId: "environment-one" });
  });
  it("updates only model/reasoning and never stops or sends to an active thread", async () => {
    const f = await setup();
    await f.harness.behavior.callRpc("apply", apply);
    expect(f.harness.inspection.sdk.callsTo("threads.update")[0][0]).toEqual({
      threadId: "thread-one",
      model: "model-one",
      reasoningLevel: "medium",
    });
    expect(f.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    expect(f.harness.inspection.sdk.callsTo("threads.send")).toHaveLength(0);
  });
  it("rejects provider changes in place before mutation", async () => {
    const f = await setup();
    await expect(
      f.harness.behavior.callRpc("apply", { ...apply, providerId: "pi" }),
    ).rejects.toThrow();
    expect(f.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });
  it("rechecks routing after the user loaded a snapshot", async () => {
    const f = await setup();
    await f.harness.behavior.callRpc("catalog", { threadId: "thread-one" });
    f.setPooled(false);
    await expect(f.harness.behavior.callRpc("apply", apply)).rejects.toThrow(
      "Подключение изменилось",
    );
    expect(f.harness.inspection.sdk.callsTo("threads.update")).toHaveLength(0);
  });
  it("recognizes thread bypass independently from global routing", async () => {
    const f = await setup();
    f.setBypassed(true);
    await expect(f.harness.behavior.callRpc("apply", apply)).rejects.toThrow(
      "Подключение изменилось",
    );
    await f.harness.behavior.callRpc("apply", {
      ...apply,
      expectedGroup: "local",
    });
  });
  it("stores chooser visibility without disabling a provider or changing pool routing", async () => {
    const f = await setup();
    await f.harness.behavior.callRpc("visibility", {
      hostId: "host-one",
      providerId: "pi",
      hidden: true,
    });
    expect(await f.bb.storage.kv.get("hidden:host-one")).toEqual(["pi"]);
    expect(
      f.harness.inspection.sdk.calls.every(
        (c) => !c.path.includes("setEnabled"),
      ),
    ).toBe(true);
    expect(
      f.harness.inspection.sdk
        .callsTo("plugins.callRpc")
        .every(
          (c) =>
            z.object({ method: z.string() }).parse(c[0]).method !==
            "routing.set",
        ),
    ).toBe(true);
  });
  it("preserves concurrent visibility edits on the same host", async () => {
    const f = await setup();
    await Promise.all(
      ["codex", "pi"].map((providerId) =>
        f.harness.behavior.callRpc("visibility", {
          hostId: "host-one",
          providerId,
          hidden: true,
        }),
      ),
    );
    expect(await f.bb.storage.kv.get("hidden:host-one")).toEqual([
      "codex",
      "pi",
    ]);
  });
  it("does not guess current-thread routing when the inspection RPC fails", async () => {
    const f = await setup();
    f.harness.sdk.stub("plugins.callRpc", async (...raw: unknown[]) => {
      const args = z.object({ method: z.string() }).parse(raw[0]);
      if (args.method === "thread.account") throw Error("unavailable");
      return {
        routing: {
          codex: true,
          claude: true,
          cursor: true,
          devin: true,
          kimi: true,
          zai: true,
          "opencode-go": true,
        },
        accounts: [{ provider: "codex", enabled: true }],
      };
    });
    const data = catalogOutput.parse(
      await f.harness.behavior.callRpc("catalog", { threadId: "thread-one" }),
    );
    expect(data.connections.find((row) => row.id === "codex")).toMatchObject({
      selectable: false,
      detail: "Маршрут треда не подтверждён",
    });
  });
  it("uses native spawn with full inputs and parent linkage, and is idempotent on replay", async () => {
    const f = await setup();
    const input = create();
    const first = await f.harness.behavior.callRpc("create", input);
    const second = await f.harness.behavior.callRpc("create", input);
    expect(second).toEqual(first);
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect(
      f.harness.inspection.sdk.callsTo("threads.spawn")[0][0],
    ).toMatchObject({ ...input.request, parentThreadId: "thread-one" });
  });
  it("does not resend after an unknown spawn result, including plugin reload", async () => {
    const f = await setup();
    f.harness.sdk.stub("threads.spawn", async () => {
      throw Error("connection lost");
    });
    const input = create();
    await expect(f.harness.behavior.callRpc("create", input)).rejects.toThrow(
      "connection lost",
    );
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(1);
    const next = await f.harness.lifecycle.reload(plugin);
    await expect(
      next.harness.behavior.callRpc("create", input),
    ).rejects.toThrow("Запуск уже запрошен");
    expect(next.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(
      0,
    );
    await expect(
      next.harness.behavior.callRpc("create", {
        ...input,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("Запуск уже запрошен");
    expect(next.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(
      0,
    );
  });
  it("rejects a changed request with the same creation id", async () => {
    const f = await setup();
    const input = create();
    await f.harness.behavior.callRpc("create", input);
    await expect(
      f.harness.behavior.callRpc("create", {
        ...input,
        request: { ...input.request, model: "different" },
      }),
    ).rejects.toThrow("Запрос изменился");
  });
  it("rejects inherited execution provenance instead of spawning a different default", async () => {
    const f = await setup();
    const input = create();
    input.request.executionInputSources = {
      providerId: "",
      model: "",
      reasoningLevel: "",
    };
    await expect(f.harness.behavior.callRpc("create", input)).rejects.toThrow();
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
  it("does not silently switch auth route when creating from a bypassed thread", async () => {
    const f = await setup();
    f.setBypassed(true);
    const input = { ...create(), expectedGroup: "local" };
    await expect(f.harness.behavior.callRpc("create", input)).rejects.toThrow(
      "Подключение изменилось",
    );
    expect(f.harness.inspection.sdk.callsTo("threads.spawn")).toHaveLength(0);
  });
});
