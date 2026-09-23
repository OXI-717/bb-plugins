import cronstrue from "cronstrue/i18n.js";
export function catalogSchedule(schedule: string | null): string {
  if (!schedule) return "По запросу / расписание не указано";
  const cron =
    /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)(?:\s+([A-Za-z_]+(?:\/[A-Za-z_+-]+)+|UTC))?$/.exec(
      schedule,
    );
  if (cron) {
    try {
      return (
        cronstrue.toString(cron[1], {
          use24HourTimeFormat: true,
          locale: "ru",
          throwExceptionOnParseError: true,
        }) + (cron[2] ? ` · ${cron[2]}` : "")
      );
    } catch {}
  }
  if (
    /^\d{4}-\d{2}-\d{2}T/.test(schedule) &&
    Number.isFinite(Date.parse(schedule))
  )
    return `Однократно · ${new Date(schedule).toLocaleString("ru-RU")}`;
  const interval = /^Every (\d+) seconds$/.exec(schedule);
  if (interval) {
    const seconds = Number(interval[1]);
    if (seconds % 3600 === 0) return `Каждые ${seconds / 3600} ч`;
    if (seconds % 60 === 0) return `Каждые ${seconds / 60} мин`;
    return `Каждые ${seconds} с`;
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
            ? `Каждые ${item.value.replace(/(\d+)min\b/g, "$1 мин").replace(/(\d+)h\b/g, "$1 ч")}`
            : item.kind === "event" && item.value === "always-on"
              ? "Работает постоянно"
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
            "Воскресенье",
            "Понедельник",
            "Вторник",
            "Среда",
            "Четверг",
            "Пятница",
            "Суббота",
            "Воскресенье",
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
        parts.push(`${item.Day}-е число месяца`);
      }
      if ("Month" in item) {
        if (
          typeof item.Month !== "number" ||
          !Number.isInteger(item.Month) ||
          item.Month < 1 ||
          item.Month > 12
        )
          return null;
        parts.push(`${item.Month}-й месяц`);
      }
      if (!parts.length) parts.push("Ежедневно");
      return `${parts.join(", ")} в ${String(item.Hour).padStart(2, "0")}:${String(item.Minute).padStart(2, "0")}`;
    });
    return labels.length && labels.every((label) => label !== null)
      ? labels.join("; ") + (schedule.endsWith(suffix) ? " (часовой пояс хоста)" : "")
      : schedule;
  } catch {
    return schedule;
  }
}

function systemCalendar(value: string): string {
  const interval = /^\*:0\/(\d+)$/.exec(value);
  if (interval) return `Каждые ${interval[1]} мин`;
  const daily = /^(\d{2}(?:,\d{2})*):(\d{2})$/.exec(value);
  if (daily)
    return `Ежедневно в ${daily[1]
      .split(",")
      .map((hour) => `${hour}:${daily[2]}`)
      .join(", ")}`;
  const weekly =
    /^(Mon\.\.Fri|Mon|Tue|Wed|Thu|Fri|Sat|Sun) \*-\*-\* (\d{2}:\d{2})(?::00)?(.*)$/.exec(
      value,
    );
  const days: Record<string, string> = {
    "Mon..Fri": "По будням",
    Mon: "Понедельник",
    Tue: "Вторник",
    Wed: "Среда",
    Thu: "Четверг",
    Fri: "Пятница",
    Sat: "Суббота",
    Sun: "Воскресенье",
  };
  return weekly ? `${days[weekly[1]]} в ${weekly[2]}${weekly[3]}` : value;
}
