import cronstrue from "cronstrue";
export function catalogSchedule(schedule: string | null): string {
  if (!schedule) return "On demand / no schedule supplied";
  const cron =
    /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC))?$/.exec(
      schedule,
    );
  if (cron) {
    try {
      return (
        cronstrue.toString(cron[1], {
          use24HourTimeFormat: true,
          throwExceptionOnParseError: true,
        }) + (cron[2] ? ` · ${cron[2]}` : "")
      );
    } catch {}
  }
  if (
    /^\d{4}-\d{2}-\d{2}T/.test(schedule) &&
    Number.isFinite(Date.parse(schedule))
  )
    return `Once · ${new Date(schedule).toLocaleString()}`;
  const interval = /^Every (\d+) seconds$/.exec(schedule);
  if (interval) {
    const seconds = Number(interval[1]);
    if (seconds % 3600 === 0) return `Every ${seconds / 3600} hours`;
    if (seconds % 60 === 0) return `Every ${seconds / 60} minutes`;
    return schedule;
  }
  const suffix = " (host timezone)";
  try {
    const value: unknown = JSON.parse(
      schedule.endsWith(suffix) ? schedule.slice(0, -suffix.length) : schedule,
    );
    const items: unknown[] = Array.isArray(value) ? value : [value];
    const labels = items.map((item) => {
      if (!item || typeof item !== "object") return null;
      if ("kind" in item && "value" in item && typeof item.value === "string") {
        const label =
          item.kind === "interval"
            ? `Every ${item.value.replace(/(\d+)min\b/g, "$1 minutes").replace(/(\d+)h\b/g, "$1 hours")}`
            : item.kind === "event" && item.value === "always-on"
              ? "Continuously running"
              : systemCalendar(item.value);
        return (
          label +
          ("timezone" in item &&
          typeof item.timezone === "string" &&
          !label.endsWith(item.timezone)
            ? ` (${item.timezone})`
            : "")
        );
      }
      if (
        !("Hour" in item) ||
        !("Minute" in item) ||
        typeof item.Hour !== "number" ||
        typeof item.Minute !== "number"
      )
        return null;
      if (
        !Number.isInteger(item.Hour) ||
        item.Hour < 0 ||
        item.Hour > 23 ||
        !Number.isInteger(item.Minute) ||
        item.Minute < 0 ||
        item.Minute > 59
      )
        return null;
      if (
        Object.keys(item).some(
          (key) => !["Hour", "Minute", "Day", "Weekday", "Month"].includes(key),
        )
      )
        return null;
      const parts: string[] = [];
      if ("Weekday" in item) {
        if (
          typeof item.Weekday !== "number" ||
          !Number.isInteger(item.Weekday) ||
          item.Weekday < 0 ||
          item.Weekday > 7
        )
          return null;
        parts.push(
          [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
            "Sunday",
          ][item.Weekday],
        );
      }
      if ("Day" in item) {
        if (
          typeof item.Day !== "number" ||
          !Number.isInteger(item.Day) ||
          item.Day < 1 ||
          item.Day > 31
        )
          return null;
        parts.push(`Day ${item.Day} of the month`);
      }
      if ("Month" in item) {
        if (
          typeof item.Month !== "number" ||
          !Number.isInteger(item.Month) ||
          item.Month < 1 ||
          item.Month > 12
        )
          return null;
        parts.push(`month ${item.Month}`);
      }
      if (!parts.length) parts.push("Daily");
      return `${parts.join(", ")} at ${String(item.Hour).padStart(2, "0")}:${String(item.Minute).padStart(2, "0")}`;
    });
    return labels.length && labels.every((label) => label !== null)
      ? labels.join("; ") + (schedule.endsWith(suffix) ? suffix : "")
      : schedule;
  } catch {
    return schedule;
  }
}

function systemCalendar(value: string): string {
  const interval = /^\*:0\/(\d+)$/.exec(value);
  if (interval) return `Every ${interval[1]} minutes`;
  const daily = /^(\d{2}(?:,\d{2})*):(\d{2})$/.exec(value);
  if (daily)
    return `Daily at ${daily[1]
      .split(",")
      .map((hour) => `${hour}:${daily[2]}`)
      .join(", ")}`;
  const weekly =
    /^(Mon\.\.Fri|Mon|Tue|Wed|Thu|Fri|Sat|Sun) \*-\*-\* (\d{2}:\d{2})(?::00)?(.*)$/.exec(
      value,
    );
  const days: Record<string, string> = {
    "Mon..Fri": "Weekdays",
    Mon: "Monday",
    Tue: "Tuesday",
    Wed: "Wednesday",
    Thu: "Thursday",
    Fri: "Friday",
    Sat: "Saturday",
    Sun: "Sunday",
  };
  return weekly ? `${days[weekly[1]]} at ${weekly[2]}${weekly[3]}` : value;
}
