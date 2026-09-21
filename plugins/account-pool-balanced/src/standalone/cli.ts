import fs from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import { accountSchema, accountSecretSchema, accountPoolConfigSchema, providerSchema } from "../contracts.js";
import { openPool } from "./runtime.js";
import { listenPool } from "./http.js";

const help = `Standalone account pool (Node 22+)
  npm run pool -- --data-dir DIRECTORY [--config FILE] serve [--port 8787] [--host 127.0.0.1]
  npm run pool -- --data-dir DIRECTORY import-account < account.json
  npm run pool -- --data-dir DIRECTORY import-devin < devin-account.json
  npm run pool -- --data-dir DIRECTORY import-login --provider claude|codex
  npm run pool -- --data-dir DIRECTORY client-add --client NAME --output PRIVATE_FILE
  npm run pool -- --data-dir DIRECTORY client-revoke --client NAME
  npm run pool -- --data-dir DIRECTORY accounts
Stop the standalone server before administrative commands. Never use BB's data directory.
Account input is { account: {...metadata}, secret: {...} }; see docs/external-clients.md.
Tokens are written only to a new mode-0600 file; never printed.`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    "data-dir": { type: "string" }, config: { type: "string" }, port: { type: "string", default: "8787" },
    host: { type: "string", default: "127.0.0.1" }, client: { type: "string" }, output: { type: "string" },
    provider: { type: "string" }, help: { type: "boolean" },
  } });
  if (values.help) { console.log(help); return; }
  const command = positionals[0];
  if (positionals.length !== 1 || !["serve", "import-account", "import-devin", "import-login", "client-add", "client-revoke", "accounts"].includes(command ?? "") || !values["data-dir"]) throw new Error("Use --help for usage.");
  const config = values.config ? accountPoolConfigSchema.parse(JSON.parse(await fs.readFile(values.config, "utf8"))) : {};
  const port = z.coerce.number().int().min(1).max(65535).parse(values.port);
  const pool = await openPool(values["data-dir"], config);
  try {
    if (command === "serve") {
      const server = await listenPool(pool, { port, host: values.host });
      console.log(`Pool listening on ${server.url}`);
      await new Promise<void>(resolve => {
        const stop = () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); resolve(); };
        process.once("SIGINT", stop); process.once("SIGTERM", stop);
      });
      await server.close();
    } else if (command === "import-account" || command === "import-devin") {
      let input = "";
      for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 64 * 1024) throw new Error("Account input too large."); }
      if (command === "import-devin") { await pool.devin.add(JSON.parse(input)); console.log("Devin account added."); return; }
      const parsed = z.object({
        account: accountSchema.omit({ id: true, createdAt: true, lastUsedAt: true, lastUsedHostId: true }),
        secret: accountSecretSchema,
      }).strict().parse(JSON.parse(input));
      if (parsed.account.kind !== parsed.secret.kind) throw new Error("Account and secret kinds must match.");
      if (parsed.account.provider === "codex" && (parsed.secret.kind !== "oauth" || !parsed.account.codexAccountId)) throw new Error("Codex requires OAuth and codexAccountId.");
      if (!["claude", "codex"].includes(parsed.account.provider) && parsed.secret.kind !== "api-key") throw new Error("This provider requires an API key.");
      const account = await pool.accounts.add(parsed.account, parsed.secret);
      console.log(`Added account ${account.id}`);
    } else if (command === "import-login") {
      const provider = providerSchema.extract(["claude", "codex"]).parse(values.provider);
      const imported = await pool.hub.importAccount(provider);
      const account = await pool.accounts.add({ provider, kind: "oauth", label: imported.label, email: imported.email, accountUuid: imported.accountUuid ?? null, codexAccountId: imported.codexAccountId, subscriptionType: imported.subscriptionType, rateLimitTier: imported.rateLimitTier, enabled: true, priority: (await pool.accounts.list()).length }, imported.secret);
      console.log(`Imported account ${account.id}`);
    } else if (command === "client-add") {
      const client = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/).parse(values.client);
      if (!values.output) throw new Error("--output is required.");
      // Exclusive creation prevents symlink following and accidental overwrite.
      const file = await fs.open(values.output, "wx", 0o600);
      try { await file.writeFile(`${await pool.tokens.forHost(client)}\n`); } finally { await file.close(); }
      console.log("Client token saved to private output file.");
    } else if (command === "client-revoke") {
      const client = z.string().min(1).parse(values.client);
      await pool.tokens.prune((await pool.tokens.list()).map(t => t.hostId).filter(id => id !== client));
      console.log("Client revoked.");
    } else {
      console.log(JSON.stringify(await pool.accounts.list(), null, 2));
    }
  } finally { await pool.close(); }
}

main().catch(() => {
  // Validation/provider errors can contain submitted data; never dump them.
  console.error("Pool command failed. Check arguments, input schema, file permissions and whether the data directory is already in use. Use --help.");
  process.exitCode = 1;
});
