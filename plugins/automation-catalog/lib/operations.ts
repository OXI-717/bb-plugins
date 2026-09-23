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
  const paused = task.state === "paused";
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
        ? " · Ошибка связи с источником"
        : rank < 4 &&
            source &&
            (source.lastSuccessAt === null ||
              now - source.lastSuccessAt > source.staleAfterMs)
          ? " · Данные устарели"
          : ""),
    rank,
    attention,
    tone,
    paused,
  });
  if (task.missing)
    return result(
      "Отсутствует",
      "Нет в последнем списке источника",
      0,
      true,
      "danger",
    );
  if (task.state === "blocked")
    return result(
      "Заблокирована",
      "Планировщик сообщает о блокировке выполнения",
      1,
      true,
      "danger",
    );
  if (task.state === "failed")
    return result(
      "Ошибка",
      "Планировщик сообщает об ошибке",
      2,
      true,
      "danger",
    );
  if (task.lastRun?.status === "failed")
    return result(
      "Последний запуск завершился ошибкой",
      paused
        ? "Отключена · последний запуск с ошибкой"
        : task.state === "active"
          ? "Включена · последний запуск с ошибкой"
          : "Последний записанный запуск с ошибкой",
      3,
      true,
      "danger",
    );
  if (source?.error)
    return result(
      "Ошибка соединения",
      "Не удалось обновить источник; показаны последние известные данные",
      4,
      false,
    );
  if (
    source &&
    (source.lastSuccessAt === null ||
      now - source.lastSuccessAt > source.staleAfterMs)
  )
    return result(
      "Данные устарели",
      "Текущее состояние требует проверки",
      5,
      false,
    );
  if (
    !paused &&
    source &&
    task.nextRunAt != null &&
    now - task.nextRunAt > Math.max(source?.staleAfterMs ?? 60000, 60000) &&
    !["running", "queued"].includes(task.lastRun?.status ?? "")
  )
    return result(
      "Просрочена",
      "Время запуска прошло; проверьте планировщик",
      6,
    );
  if (task.lastRun?.status === "running")
    return result("Выполняется", "Идёт выполнение", 6, false);
  if (task.lastRun?.status === "queued")
    return result("В очереди", "Ожидает выполнения", 7, false);
  if (paused)
    return result("Отключена", "Запуск по расписанию приостановлен", 8, false);
  if (task.state === "unknown")
    return result(
      "Нет данных о запусках",
      task.declaredState
        ? `В реестре указано: ${automationStateLabel(task.declaredState)}. Фактическое состояние не подключено.`
        : "Фактическое состояние и история запусков не подключены",
      9,
      false,
    );
  return result(
    "Включена",
    task.lastRun
      ? "Расписание включено"
      : "Расписание включено; данных о запусках пока нет",
    10,
    false,
  );
}
export function runLabel(status: string) {
  return (
    (
      {
        succeeded: "Успешно",
        failed: "Ошибка",
        running: "Выполняется",
        queued: "В очереди",
        skipped: "Пропущено",
        cancelled: "Отменено",
        unknown: "Результат недоступен",
      } as Record<string, string>
    )[status] ?? "Результат недоступен"
  );
}
export function automationStateLabel(state: string) {
  return ({ active: "Включена", paused: "Отключена", blocked: "Заблокирована", failed: "Ошибка", unknown: "Неизвестно" } as Record<string, string>)[state] ?? state;
}
export function timestamp(value: number | null | undefined) {
  return value == null
    ? "—"
    : new Date(value).toLocaleString("ru-RU", {
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
    ? `${seconds} с`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
      : `${Math.floor(seconds / 3600)} ч ${Math.floor((seconds % 3600) / 60)} мин`;
}
export function scopeLabel(scope: string) {
  return scope === "personal"
    ? "Личная"
    : scope === "team"
      ? "Командная"
      : "Не задано";
}
export function sourceLabel(name: string) {
  return ({ "AIM server registry": "Реестр сервера AIM", "AIM team automations": "Командные автоматизации AIM" } as Record<string, string>)[name] ?? name;
}
export const creationTypes = [
  {
    id: "bb",
    label: "Автоматизация BB",
    description: "Агент или скрипт по расписанию BB.",
    skill: "automations",
  },
  {
    id: "local",
    label: "Локальная автоматизация",
    description: "Запуск на вашем компьютере через его планировщик.",
    skill: "oxi-launchd",
  },
  {
    id: "server",
    label: "Серверная автоматизация",
    description: "Запуск на подключённом сервере через его планировщик.",
    skill: null,
  },
] as const;
export function creationPrompt(type: string, scope: string) {
  const route =
    creationTypes.find((item) => item.id === type) ?? creationTypes[0];
  return `Помоги создать ${scope === "team" ? "командную" : "личную"} автоматизацию. Где запускать: ${route.label}.\n${route.skill ? `Используй установленный скилл ${route.skill}.` : "Найди установленный скилл или клиент для создания серверной автоматизации и проверь доступные варианты запуска."}\nСпроси, что автоматизация должна делать и когда запускаться. Проверь место запуска, владельца, часовой пояс и возможности планировщика. Если выбранный планировщик не поддерживает нужный тип владения, объясни это до создания. Для задачи без рассуждений предпочти скрипт. Не заменяй выбранный планировщик. После создания добавь автоматизацию в каталог и проверь её расписание и состояние.\nОписание задачи: `;
}
