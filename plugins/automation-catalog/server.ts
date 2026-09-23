import { PLUGIN_CLI_OUTPUT_MAX_BYTES, type BbPluginApi } from "@get-bb/plugin-sdk";
import { catalogMigration, registerCatalog } from "./src/catalog";

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  db.exec("PRAGMA foreign_keys = ON");
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS catalog_migrations (version INTEGER PRIMARY KEY)");
    if (!db.prepare("SELECT version FROM catalog_migrations WHERE version = 1").get()) {
      db.exec(catalogMigration);
      db.prepare("INSERT INTO catalog_migrations(version) VALUES (1)").run();
    }
  })();
  const catalog = registerCatalog(bb, db);
  function reply(value: unknown) {
    const stdout = JSON.stringify(value);
    if (Buffer.byteLength(stdout) > PLUGIN_CLI_OUTPUT_MAX_BYTES) return { exitCode: 1, stderr: "Result exceeds CLI output limit; use catalog RPC or narrow history pagination." };
    return { exitCode: 0, stdout };
  }
  bb.cli.register({
    name: "automation-catalog",
    summary: "Inspect automation inventory and execution history",
    commands: [
      { name: "list", summary: "List catalog entries", usage: "bb automation-catalog list [--json]" },
      { name: "detail", summary: "Read execution history", usage: "bb automation-catalog detail <key> [--offset N] [--json]" },
    ],
    async run(argv) {
      const args = argv.filter(arg => arg !== "--json");
      const command = args.shift();
      if (command === "list" && args.length === 0) {
        const data = catalog.list();
        const page = { ...data, tasks: data.tasks.slice(0, 100), total: data.tasks.length };
        return reply(page);
      }
      if (command === "detail" && (args.length === 1 || (args.length === 3 && args[1] === "--offset"))) {
        return reply(catalog.detail({ key: args[0], offset: Number(args[2] ?? 0), limit: 25 }));
      }
      return { exitCode: command === undefined || command === "--help" ? 0 : 1, stdout: "bb automation-catalog list [--json]\nbb automation-catalog detail <key> [--offset N] [--json]\nPublish: bb plugin rpc call automation-catalog catalog_publish --input-file snapshot.json" };
    },
  });
}
