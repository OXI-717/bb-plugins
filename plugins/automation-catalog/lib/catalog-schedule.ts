export function catalogSchedule(schedule: string | null): string {
  if (!schedule) return "No schedule declared";
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
          item.kind === "interval" ? `Every ${item.value}` : item.value;
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
