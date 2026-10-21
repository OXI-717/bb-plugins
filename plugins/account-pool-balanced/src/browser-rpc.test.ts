import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountPoolRpcContract, createRpcHandlers } from "./rpc.js";

// Construct synthetic userinfo explicitly; it must never reach the launcher.
const userinfoUrl = new URL("https://login.example/");
userinfoUrl.username = "TEST_USER";
userinfoUrl.password = "TEST_PASSWORD";

const accountId = "11111111-1111-4111-8111-111111111111";
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

function fixture() {
  const host = createFakePluginHost({ pluginId: "account-pool-balanced" });
  const openBrowser = vi.fn(async (_input: { accountId: string; url?: string }) => ({ opened: true as const }));
  const unused = {} as never;
  host.bb.rpc.register(accountPoolRpcContract, createRpcHandlers(unused, unused, unused, unused, undefined, undefined, openBrowser));
  disposals.push(() => host.harness.lifecycle.dispose());
  return { call: (input: unknown) => host.harness.behavior.callRpc("browser.open", input), openBrowser };
}

describe("account browser RPC", () => {
  it("delegates a stable account ID and optional authorization link, returning only acknowledgement", async () => {
    const { call, openBrowser } = fixture();
    expect(await call({ accountId })).toEqual({ opened: true });
    expect(openBrowser).toHaveBeenLastCalledWith({ accountId });
    const url = "https://login.example/authorize?state=synthetic";
    expect(await call({ accountId, url })).toEqual({ opened: true });
    expect(openBrowser).toHaveBeenLastCalledWith({ accountId, url });
  });

  it.each([
    { accountId: "person@example.com" },
    { accountId, url: "file:///tmp/page" },
    { accountId, url: "http://login.example/" },
    { accountId, url: userinfoUrl.href },
    { accountId, url: "https://login.example/" + "x".repeat(8192) },
    { accountId, executable: "/tmp/untrusted" },
  ])("rejects invalid launch input before touching profiles: %j", async input => {
    const { call, openBrowser } = fixture();
    await expect(call(input)).rejects.toThrow();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("propagates launch failure without reporting success", async () => {
    const { call, openBrowser } = fixture();
    openBrowser.mockRejectedValueOnce(new Error("VPN not verified"));
    await expect(call({ accountId })).rejects.toThrow("VPN not verified");
  });
});
