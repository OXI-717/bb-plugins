import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { accountPoolConfigSchema } from "./contracts.js";
import { createVpnPolicy, readVpnState, VpnRequiredError, vpnStateFromPayload } from "./vpn-policy.js";

const now = 1_800_000_000_000;
const payload = { schema: "oxi-vpnks/vpn-state/1", updated_unix: now / 1000, state: "connected" };
describe("VPN permission", () => {
  it.each([
    [payload, now, "connected"],
    [payload, now + 60_000, "connected"],
    [payload, now + 60_001, "unknown"],
    [payload, now - 1, "unknown"],
    [{ ...payload, state: "disconnected" }, now, "disconnected"],
    [{ ...payload, schema: "other" }, now, "unknown"],
    [{ ...payload, updated_unix: "invalid" }, now, "unknown"],
    [null, now, "unknown"],
  ])("validates status and freshness", (value, time, expected) => {
    expect(vpnStateFromPayload(value, time)).toBe(expected);
  });
  it("denies protected providers on every uncertain state and leaves others independent", async () => {
    const reader = vi.fn(async () => { throw new Error("unavailable"); });
    const policy = createVpnPolicy(() => accountPoolConfigSchema.parse({}), () => now, reader);
    for (const provider of ["kimi", "zai", "opencode-go"] as const) await policy.assert(provider);
    expect(reader).not.toHaveBeenCalled();
    for (const provider of ["codex", "claude", "cursor", "devin"] as const) await expect(policy.assert(provider)).rejects.toBeInstanceOf(VpnRequiredError);
    expect(reader).toHaveBeenCalledTimes(4);
  });
  it("checks live configuration and connection for each call", async () => {
    const settings = accountPoolConfigSchema.parse({});
    let state: "connected" | "disconnected" = "connected";
    const policy = createVpnPolicy(() => settings, () => now, async () => state);
    await policy.assert("codex");
    state = "disconnected";
    await expect(policy.assert("codex")).rejects.toBeInstanceOf(VpnRequiredError);
    settings.vpnOnlyProviders = [];
    await policy.assert("codex");
  });
  it("rejects missing, symlinked and writable files", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "vpn-policy-"));
    try {
      const file = path.join(directory, "state.json");
      expect(await readVpnState(file, now)).toBe("unknown");
      await writeFile(file, JSON.stringify(payload), { mode: 0o666 });
      await chmod(file, 0o666);
      expect(await readVpnState(file, now)).toBe("unknown");
      const link = path.join(directory, "link.json");
      await symlink(file, link);
      expect(await readVpnState(link, now)).toBe("unknown");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
