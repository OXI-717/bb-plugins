import { migratePermanentThreads } from "./permanent.js";
// Fork of bb-plugin-auto-archive 0.1.0 by Shane Logsdon, MIT (see LICENSE).
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  runOperation,
  parseDays,
  parseKeep,
  summarize,
  exclusionStatus,
} from "./runtime.js";
import { msUntilNextHour, sleep } from "./upstream-timing.js";
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    inactivityDays: {
      type: "string",
      label: "Inactivity threshold (days)",
      default: "14",
    },
    keepThreadIds: {
      type: "string",
      label: "Never archive these thread IDs (JSON array)",
      default: "[]",
    },
    detachActiveDescendants: {
      type: "boolean",
      label: "Detach active descendants when supported",
      default: false,
    },
    dryRun: {
      type: "boolean",
      label: "Preview only; never archive or detach",
      default: true,
    },
  });
  let installedAt = await bb.storage.kv.get<number>("installed-at");
  if (
    typeof installedAt !== "number" ||
    !Number.isFinite(installedAt) ||
    installedAt <= 0
  ) {
    installedAt = Date.now();
    await bb.storage.kv.set("installed-at", installedAt);
  }
  const sinceInstallAt = installedAt;
  const resolve = async () => {
    const s = await settings.get();
    return {
      inactivityDays: parseDays(s.inactivityDays),
      keepThreadIds: parseKeep(s.keepThreadIds),
      sinceInstallAt,
      detachActiveDescendants: s.detachActiveDescendants,
      dryRun: s.dryRun,
    };
  };
  // No archive operation is registered until legacy protection is persisted.
  await migratePermanentThreads(bb, (await resolve()).keepThreadIds);
  let running = false;
  const execute = async (options: {
    dryRun?: boolean;
    targetId?: string;
    signal?: AbortSignal;
  }) => {
    if (running)
      throw new Error("An auto-archive operation is already running");
    running = true;
    try {
      const report = summarize(
        await runOperation(bb, await resolve(), options),
      );
      await bb.storage.kv.set("last-sweep", { at: Date.now(), ...report });
      return report;
    } finally {
      running = false;
    }
  };
  bb.background.service("sweeper", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          const r = await execute({ signal });
          bb.log.info(
            `sweep: ${r.actions.length} candidates, ${r.archivedRoots} archived, dryRun=${r.dryRun}`,
          );
        } catch (e) {
          if (!signal.aborted) bb.log.error(String(e));
        }
        await sleep(msUntilNextHour(), signal);
      }
    },
  });
  const options = {
    "dry-run": {
      type: "boolean" as const,
      description: "Preview only; never change thread links or archive",
    },
    json: { type: "boolean" as const, description: "Return JSON" },
  };
  bb.cli.register(
    defineCli({
      name: "auto-archive",
      summary: "Preview or archive quiet thread trees",
      commands: {
        run: cliCommand({
          summary: "Sweep post-install inactive trees",
          options,
          async run(input, ctx) {
            const result = await execute({
              dryRun: input.options["dry-run"],
              signal: ctx.signal,
            });
            return { exitCode: 0, stdout: JSON.stringify(result, null, 2) };
          },
        }),
        prune: cliCommand({
          summary:
            "Keep a live thread and prune quiet ancestors; immutable owner links block removal",
          positionals: [
            {
              name: "thread-id",
              description: "Live thread to preserve",
              required: true,
            },
          ],
          options,
          async run(input, ctx) {
            const result = await execute({
              targetId: input.positionals["thread-id"],
              dryRun: input.options["dry-run"],
              signal: ctx.signal,
            });
            return {
              exitCode: result.blocked.length && !result.actions.length ? 1 : 0,
              stdout: JSON.stringify(result, null, 2),
            };
          },
        }),
        status: cliCommand({
          summary: "Show settings, install boundary and last result",
          options: { json: options.json },
          async run(_input, ctx) {
            const config = await resolve();
            const exclusions = await exclusionStatus(bb, config, ctx.signal);
            return {
              exitCode: 0,
              stdout: JSON.stringify(
                {
                  config,
                  exclusions,
                  last: await bb.storage.kv.get("last-sweep"),
                },
                null,
                2,
              ),
            };
          },
        }),
      },
    }),
  );
}
