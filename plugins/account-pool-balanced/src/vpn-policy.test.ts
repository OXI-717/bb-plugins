import {vpnProof} from './vpn-test-fixture.js';
import { describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { accountPoolConfigSchema,accountPoolConfigSetInputSchema } from "./contracts.js";
import { createVpnPolicy, readVpnState, VpnRequiredError, vpnStateFromPayload } from "./vpn-policy.js";

const now = 1_800_000_000_000;
const payload = vpnProof(now)!;
it('discards the retired switch without losing saved routing configuration',()=>{
 const settings=accountPoolConfigSchema.parse({requireVerifiedVpn:false,vpnStatusFile:'/configured/state.json',vpnGuardEnabled:true,restDays:[2]});
 expect(settings).not.toHaveProperty('requireVerifiedVpn');
 expect(settings).toMatchObject({vpnPolicyVersion:2,vpnStatusFile:'/configured/state.json',vpnGuardEnabled:true,restDays:[2]});
});
it('cannot disable verification through a retired setting or a policy-version setter',()=>{
 expect(accountPoolConfigSetInputSchema.safeParse({requireVerifiedVpn:false}).success).toBe(false);
 expect(accountPoolConfigSetInputSchema.safeParse({vpnPolicyVersion:1}).success).toBe(false);
});
it('refuses legacy permission for all protected providers even after a saved opt-out',async()=>{
 const settings=accountPoolConfigSchema.parse({requireVerifiedVpn:false});
 const policy=createVpnPolicy(()=>settings,()=>now,async()=>({schema:'oxi-vpnks/vpn-state/1',state:'connected',updated_unix:now/1000}));
 for(const provider of ['codex','claude','cursor','devin'] as const)await expect(policy.assert(provider)).rejects.toBeInstanceOf(VpnRequiredError);
 await policy.assert('kimi');await policy.assert('zai');
});
describe("VPN permission", () => {
  it.each([
    [payload, now, "connected"],
    [payload, now + 90_000, "connected"],
    [payload, now + 90_001, "unknown"],
    [payload, now - 1, "unknown"],
    [{ ...payload, state: "disconnected",reason:"probe_failed" }, now, "disconnected"],
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
    const policy = createVpnPolicy(() => settings, () => now, async timestamp => vpnProof(timestamp,state));
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
