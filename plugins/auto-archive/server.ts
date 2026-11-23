import { migratePermanentThreads, recordThreadUnarchived } from "./permanent.js";
// Fork of bb-plugin-auto-archive 0.1.0 by Shane Logsdon, MIT (see LICENSE).
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  runOperation,
  parseDays,
  parseKeep,
  parseMultiplier,
  parseMaxPerRun,
  parseOriginPluginIds,
  summarize,
  exclusionStatus,
} from "./runtime.js";
import { validateExportDir } from "./export.js";
import { DEFAULT_AUTOMATED_ORIGIN_PLUGINS } from "./retention-policy.js";
import { runRetention } from "./retention.js";
import { msUntilNextHour, sleep } from "./upstream-timing.js";

const DEFAULT_AUTOMATED_PLUGINS_JSON = JSON.stringify(
  DEFAULT_AUTOMATED_ORIGIN_PLUGINS,
);

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
      label: "Preview only; never archive, detach, clear files or delete",
      default: true,
    },
    unarchiveGraceMultiplier: {
      type: "string",
      label: "Retention multiplier after unarchive (1-10)",
      default: "2",
    },
    enableArchivedFileCleanup: {
      type: "boolean",
      label: "Clear local thread-storage files of old archived threads",
      default: false,
    },
    clearArchivedFilesAfterDays: {
      type: "string",
      label: "Clear archived thread files after (days)",
      default: "14",
    },
    enableAutomatedExportDelete: {
      type: "boolean",
      label: "Export and delete old archived automated/child threads",
      default: false,
    },
    exportDeleteAfterDays: {
      type: "string",
      label: "Export & delete automated archived threads after (days)",
      default: "30",
    },
    exportDir: {
      type: "string",
      label: "Verified archive export directory (server host path)",
      default: "",
    },
    automatedOriginPluginIds: {
      type: "string",
      label: "Automated origin plugin IDs eligible for export & delete (JSON array)",
      default: DEFAULT_AUTOMATED_PLUGINS_JSON,
    },
    retentionMaxPerRun: {
      type: "string",
      label: "Max archived threads processed per retention pass (1-500)",
      default: "50",
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
      inactivityDays: parseDays(s.inactivityDays, "inactivityDays"),
      keepThreadIds: parseKeep(s.keepThreadIds),
      sinceInstallAt,
      detachActiveDescendants: s.detachActiveDescendants,
      dryRun: s.dryRun,
      unarchiveGraceMultiplier: parseMultiplier(
        s.unarchiveGraceMultiplier ?? "2",
      ),
      enableArchivedFileCleanup: s.enableArchivedFileCleanup === true,
      clearArchivedFilesAfterDays: parseDays(
        s.clearArchivedFilesAfterDays ?? "14",
        "clearArchivedFilesAfterDays",
      ),
      enableAutomatedExportDelete: s.enableAutomatedExportDelete === true,
      exportDeleteAfterDays: parseDays(
        s.exportDeleteAfterDays ?? "30",
        "exportDeleteAfterDays",
      ),
      exportDir: validateExportDir(s.exportDir ?? ""),
      automatedOriginPluginIds: parseOriginPluginIds(
        s.automatedOriginPluginIds ?? DEFAULT_AUTOMATED_PLUGINS_JSON,
      ),
      retentionMaxPerRun: parseMaxPerRun(s.retentionMaxPerRun ?? "50"),
    };
  };
  // No archive operation is registered until legacy protection is persisted.
  await migratePermanentThreads(bb, (await resolve()).keepThreadIds);

  // Track threads returned from archive so their inactivity and retention windows extend.
  bb.events?.on("thread.unarchived", async ({ thread }) => {
    try {
      const updated = await recordThreadUnarchived(bb, thread.id);
      bb.log?.info(
        `unarchive grace recorded for ${thread.id}: count=${updated.unarchiveCount}`,
      );
    } catch (error) {
      bb.log?.warn(
        `failed to record unarchive grace for ${thread.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

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

  const executeRetention = async (options: {
    dryRun?: boolean;
    limit?: number;
    signal?: AbortSignal;
  }) => {
    if (running)
      throw new Error("An auto-archive operation is already running");
    running = true;
    try {
      const config = await resolve();
      const report = await runRetention(bb, config, options);
      await bb.storage.kv.set("last-retention", { at: Date.now(), ...report });
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
        try {
          const config = await resolve();
          if (
            config.enableArchivedFileCleanup ||
            config.enableAutomatedExportDelete
          ) {
            const ret = await executeRetention({ signal });
            bb.log.info(
              `retention: files=${ret.fileCleanup.clearedCount}/${ret.fileCleanup.candidateCount} (${ret.fileCleanup.reclaimedBytes}B), deleted=${ret.exportDelete.deletedCount}/${ret.exportDelete.candidateCount}, errors=${ret.errors.length}, dryRun=${ret.dryRun}`,
            );
          }
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
      description: "Preview only; never change thread links, archive, clear files or delete",
    },
    json: { type: "boolean" as const, description: "Return JSON" },
  };
  bb.cli.register(
    defineCli({
      name: "auto-archive",
      summary: "Preview or archive quiet thread trees and manage archived retention",
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
        retention: cliCommand({
          summary:
            "Preview or run archived thread-storage cleanup and verified automated export+delete",
          options: {
            ...options,
            limit: {
              type: "string" as const,
              description: "Maximum archived threads to process per category (1-500)",
            },
          },
          async run(input, ctx) {
            const rawLimit = input.options.limit;
            const limit =
              typeof rawLimit === "string" && rawLimit.length > 0
                ? parseMaxPerRun(rawLimit)
                : undefined;
            const result = await executeRetention({
              dryRun: input.options["dry-run"],
              limit,
              signal: ctx.signal,
            });
            return {
              exitCode: result.errors.length > 0 ? 1 : 0,
              stdout: JSON.stringify(result, null, 2),
            };
          },
        }),
        status: cliCommand({
          summary: "Show settings, install boundary and last results",
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
                  lastRetention: await bb.storage.kv.get("last-retention"),
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
