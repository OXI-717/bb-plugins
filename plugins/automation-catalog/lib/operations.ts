import type { CatalogTask, CatalogList } from "../src/catalog-types";
export type Source = CatalogList["sources"][number];
export type Health = {
  label: string;
  reason: string;
  attention: boolean;
  rank: number;
  tone: "danger" | "neutral";
  paused: boolean;
};
export function health(
  task: CatalogTask,
  source?: Source,
  now = Date.now(),
): Health {
  const paused =
    task.state === "paused" ||
    (task.state === "unknown" && task.declaredState === "paused");
  const result = (
    label: string,
    reason: string,
    rank: number,
    attention = true,
    tone: Health["tone"] = "neutral",
  ): Health => ({
    label,
    reason:
      reason +
      (rank < 4 && source?.error
        ? " · Source connection problem"
        : rank < 4 &&
            source &&
            (source.lastSuccessAt === null ||
              now - source.lastSuccessAt > source.staleAfterMs)
          ? " · Data out of date"
          : ""),
    rank,
    attention,
    tone,
    paused,
  });
  if (task.missing)
    return result(
      "Missing",
      "Absent from the latest source inventory",
      0,
      true,
      "danger",
    );
  if (task.state === "blocked" || task.declaredState === "blocked")
    return result(
      "Blocked",
      task.state === "blocked"
        ? "Execution is blocked"
        : "Marked blocked in the registry",
      1,
      true,
      "danger",
    );
  if (task.state === "failed" || task.declaredState === "failed")
    return result(
      "Failed",
      task.state === "failed"
        ? "Scheduler reports a failure"
        : "Marked failed in the registry",
      2,
      true,
      "danger",
    );
  if (task.lastRun?.status === "failed")
    return result(
      "Last run failed",
      paused
        ? "Paused · last execution failed"
        : task.state === "active"
          ? "Enabled · last execution failed"
          : "Last recorded execution failed",
      3,
      true,
      "danger",
    );
  if (source?.error)
    return result(
      "Connection problem",
      "Could not refresh this source; showing last known data",
      4,
    );
  if (
    source &&
    (source.lastSuccessAt === null ||
      now - source.lastSuccessAt > source.staleAfterMs)
  )
    return result(
      "Data out of date",
      "Current execution state needs verification",
      5,
    );
  if (
    !paused &&
    source &&
    task.nextRunAt != null &&
    now - task.nextRunAt > Math.max(source?.staleAfterMs ?? 60000, 60000) &&
    !["running", "queued"].includes(task.lastRun?.status ?? "")
  )
    return result(
      "Overdue",
      "Scheduled execution time has passed; verify the scheduler",
      6,
    );
  if (task.lastRun?.status === "running")
    return result("Running", "Execution is in progress", 6, false);
  if (task.lastRun?.status === "queued")
    return result("Queued", "Waiting to execute", 7, false);
  if (paused)
    return result("Paused", "Scheduled execution is paused", 8, false);
  if (task.state === "unknown")
    return result(
      "Not monitored",
      task.declaredState
        ? `Registry: ${task.declaredState}; live execution is not connected`
        : "Live execution is not connected",
      9,
    );
  return result(
    "Enabled",
    task.lastRun
      ? "Schedule enabled"
      : "Schedule enabled; no execution received yet",
    10,
    false,
  );
}
export function runLabel(status: string) {
  return (
    (
      {
        succeeded: "Succeeded",
        failed: "Failed",
        running: "Running",
        queued: "Queued",
        skipped: "Skipped",
        cancelled: "Cancelled",
        unknown: "Result unavailable",
      } as Record<string, string>
    )[status] ?? "Result unavailable"
  );
}
export function timestamp(value: number | null | undefined) {
  return value == null
    ? "—"
    : new Date(value).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
export function duration(start: number | null, end: number | null) {
  if (start === null || end === null) return "—";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
export function scopeLabel(scope: string) {
  return scope === "personal"
    ? "Personal"
    : scope === "team"
      ? "Team"
      : "Unassigned";
}
export const creationTypes = [
  {
    id: "bb",
    label: "BB automation",
    description: "Agent or script, scheduled by BB.",
    skill: "automations",
  },
  {
    id: "local",
    label: "Local automation",
    description: "Run on your computer using its scheduler.",
    skill: "oxi-launchd",
  },
  {
    id: "server",
    label: "Server automation",
    description: "Use a connected server scheduler and its creation skill.",
    skill: null,
  },
] as const;
export function creationPrompt(type: string, scope: string) {
  const route =
    creationTypes.find((item) => item.id === type) ?? creationTypes[0];
  return `Help me create a ${scope === "team" ? "team" : "personal"} automation. Execution destination: ${route.label}.\n${route.skill ? `Use the installed ${route.skill} skill.` : "Discover the installed server-automation creation skill or client and verify the available execution profiles."}\nAsk me what it should do and when it should run. Verify the destination, ownership, timezone and execution capabilities. If the selected scheduler does not support the requested personal/team ownership, explain the mismatch before creating anything. Prefer a script when reasoning is unnecessary. Do not substitute another scheduler. Register it in Automation Catalog after creation and verify that its schedule and state appear.\nTask description: `;
}
