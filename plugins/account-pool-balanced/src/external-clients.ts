import fs from "node:fs/promises";
import { z } from "zod";
import { HubTokenStore } from "./store.js";

export class ExternalClients {
  readonly tokens: HubTokenStore;
  constructor(directory: string) { this.tokens = new HubTokenStore(directory); }
  async add(name: string, outputFile: string) {
    const id = this.id(name);
    const file = await fs.open(outputFile, "wx", 0o600);
    try { await file.writeFile(`${await this.tokens.forHost(id)}\n`); }
    finally { await file.close(); }
  }
  async revoke(name: string) {
    await this.tokens.remove(this.id(name));
  }
  private id(name: string) { return `external_${z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).parse(name)}`; }
}

export function combinedTokens(hosts: HubTokenStore, clients: HubTokenStore): Pick<HubTokenStore, "authenticate" | "list"> {
  return {
    async authenticate(token) { return await hosts.authenticate(token) ?? await clients.authenticate(token); },
    async list() { return [...await hosts.list(), ...await clients.list()]; },
  };
}
