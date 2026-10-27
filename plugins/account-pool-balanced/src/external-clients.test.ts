import { expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExternalClients, combinedTokens } from "./external-clients.js";
import { HubTokenStore } from "./store.js";

it("keeps external tokens across host pruning, revokes immediately, and writes privately", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "external-test-"));
  try {
    const hosts = new HubTokenStore(path.join(dir, "hosts"));
    const clients = new ExternalClients(path.join(dir, "clients"));
    const output = path.join(dir, "client.token");
    await clients.add("orca", output);
    const token = (await fs.readFile(output, "utf8")).trim();
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
    const both = combinedTokens(hosts, clients.tokens);
    await hosts.prune([]);
    expect(await both.authenticate(token)).toBe("external_orca");
    const restored = new ExternalClients(path.join(dir, "clients"));
    expect(await restored.tokens.authenticate(token)).toBe("external_orca");
    await expect(clients.add("orca", output)).rejects.toThrow();
    await clients.revoke("orca");
    expect(await both.authenticate(token)).toBeNull();
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

 it("binds purpose to issued authority, rejects rebinding and retains rotation/grace", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "issued-purpose-"));
  try {
   const clients = new ExternalClients(path.join(dir, "clients"));
   await expect(clients.add("worker",path.join(dir,"unbound"),null,"autopilot")).rejects.toThrow('project binding');
   const file=path.join(dir,"first");
   await clients.add("worker",file,"project-one","autopilot");
   const token=(await fs.readFile(file,"utf8")).trim();
   const context={hostId:"external_worker",projectId:"project-one",purpose:"autopilot"};
   expect(await clients.tokens.authenticateContext(token)).toEqual(context);
   expect(await clients.tokens.inspectContext(token)).toEqual(context);
   await expect(clients.add("worker",path.join(dir,"legacy"),"project-one")).rejects.toThrow('binding differs');
   await expect(clients.add("worker",path.join(dir,"foreign"),"project-two","autopilot")).rejects.toThrow('binding differs');
   await clients.tokens.rotate("external_worker");
   expect(await clients.tokens.authenticateContext(token)).toEqual(context);
   const renewed=await clients.tokens.forIssuedClient("external_worker","project-one","autopilot");
   expect(renewed).not.toBe(token);
   expect(await clients.tokens.authenticateContext(renewed)).toEqual(context);
   const restored=new ExternalClients(path.join(dir,"clients"));
   expect(await restored.tokens.authenticateContext(token)).toEqual(context);
   await clients.revoke("worker");
   expect(await clients.tokens.authenticateContext(renewed)).toBeNull();
  } finally {await fs.rm(dir,{recursive:true,force:true});}
 });

 it("keeps legacy project identities compatible without allowing silent rebinding", async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"legacy-purpose-"));
  try {
   const clients=new ExternalClients(dir);
   const old=await clients.tokens.forProject("external_legacy","project-one");
   expect(await clients.tokens.forIssuedClient("external_legacy","project-one")).toBe(old);
   expect(await clients.tokens.authenticateContext(old)).toEqual({hostId:"external_legacy",projectId:"project-one"});
   await expect(clients.tokens.forIssuedClient("external_legacy","project-one","autopilot")).rejects.toThrow('binding differs');
   await expect(clients.tokens.forIssuedClient("external_legacy","project-two")).rejects.toThrow('binding differs');
   const result=await Promise.allSettled([clients.tokens.forIssuedClient("external_race","project-one","autopilot"),clients.tokens.forIssuedClient("external_race","project-two","autopilot")]);
   expect(result.filter(x=>x.status==="fulfilled")).toHaveLength(1);
   expect(result.filter(x=>x.status==="rejected")).toHaveLength(1);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
 });
