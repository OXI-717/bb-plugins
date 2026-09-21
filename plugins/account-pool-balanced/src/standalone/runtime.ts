import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { accountPoolConfigSchema, type AccountPoolConfig } from "../contracts.js";
import type { PoolKvStorage } from "../core-storage.js";
import { createHub } from "../hub.js";
import { AccountStore, HubTokenStore, PoolAffinityStore, QuotaStore, QUOTA_MIGRATIONS } from "../store.js";
import { createUpstreamTransport } from "../upstream-transport.js";
import { DevinPool } from "./devin.js";

export async function openPool(dataDir: string, config: Partial<AccountPoolConfig> = {}) {
  const settings = accountPoolConfigSchema.parse(config);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const existing = await fs.readdir(dataDir);
  if (existing.length && !existing.includes("pool.db") && !existing.includes("standalone.lock")) {
    throw new Error("Use an empty directory or an existing standalone pool directory.");
  }
  if (existing.includes("bb.db") || existing.includes("data.db")) {
    throw new Error("Use an empty directory, never BB's live storage.");
  }
  await fs.chmod(dataDir, 0o700);
  const lock = path.join(dataDir, "standalone.lock");
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Pool directory already in use (or stale standalone.lock after a crash).");
    throw error;
  }
  let db: Database.Database | undefined;
  let transport: ReturnType<typeof createUpstreamTransport> | undefined;
  try {
    db = new Database(path.join(dataDir, "pool.db"));
    await fs.chmod(path.join(dataDir, "pool.db"), 0o600);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE IF NOT EXISTS pool_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS pool_migrations (id INTEGER PRIMARY KEY)");
    const database = db;
    database.transaction(() => {
      QUOTA_MIGRATIONS.forEach((sql, id) => {
        if (database.prepare("SELECT id FROM pool_migrations WHERE id = ?").get(id)) return;
        database.exec(sql);
        database.prepare("INSERT INTO pool_migrations VALUES (?)").run(id);
      });
    })();
    const kv: PoolKvStorage = {
      async get(key) {
        const row = database.prepare("SELECT value FROM pool_kv WHERE key = ?").get(key) as { value: string } | undefined;
        return row === undefined ? undefined : JSON.parse(row.value);
      },
      async set(key, value) { database.prepare("INSERT INTO pool_kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value)); },
      async delete(key) { database.prepare("DELETE FROM pool_kv WHERE key = ?").run(key); },
      async list(prefix = "") { return (database.prepare("SELECT key FROM pool_kv ORDER BY key").all() as { key: string }[]).map(row => row.key).filter(key => key.startsWith(prefix)); },
    };
    const accounts = new AccountStore(kv, path.join(dataDir, "secrets"));
    const tokens = new HubTokenStore(path.join(dataDir, "clients"));
    await accounts.initialize();
    await tokens.initialize();
    transport = createUpstreamTransport();
    const hub = createHub({ route: "/", accounts, quotas: new QuotaStore(database), affinity: new PoolAffinityStore(database), hubTokens: tokens, getSettings: () => settings, fetch: transport.fetch });
    const controller = new AbortController();
    let running: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    return {
      accounts, tokens, hub, devin: new DevinPool(kv, path.join(dataDir, "devin"), transport.fetch),
      start() { running ??= hub.start(controller.signal); return running; },
      close() {
        return closing ??= (async () => {
          controller.abort();
          try { await hub.stop(); await transport!.destroy(); await running; }
          finally { database.close(); await fs.rmdir(lock); }
        })();
      },
    };
  } catch (error) {
    await transport?.destroy();
    db?.close();
    await fs.rmdir(lock);
    throw error;
  }
}

export type StandalonePool = Awaited<ReturnType<typeof openPool>>;
