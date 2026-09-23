import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "../server";
describe("plugin lifecycle", () => {
  it("reloads without resetting storage or registering a scheduler", () => {
    const db = new Database(":memory:");
    try {
      const rpc = { register: vi.fn() };
      const cli = { register: vi.fn() };
      const api = { storage: { database: () => db }, rpc, cli, realtime: { publish: vi.fn() } } as unknown as BbPluginApi;
      plugin(api);
      plugin(api);
      expect(db.prepare("SELECT count(*) AS count FROM catalog_migrations").get()).toEqual({ count: 1 });
      expect(rpc.register).toHaveBeenCalledTimes(2);
      expect(cli.register.mock.calls[0][0].name).toBe("automation-catalog");
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='automations'").get()).toBeUndefined();
    } finally { db.close(); }
  });
});
