import type { Snapshot } from "./model";
import type { ProjectDetail } from "./work";
export function presentProblem(raw: string) {
  if (raw.startsWith("Protection hold:"))
    return {
      title: "Автопилот остановлен защитой",
      description: raw.includes("recovery_pending")
        ? "Защитная блокировка снята, но восстановление автоматизаций ещё не завершено. Проверь список восстановления в управлении автоматизациями; обновление панели само работу не возобновляет."
        : raw,
      kind: "warning" as const,
    };

  const subscription = raw.match(/unknown subscription ['"]([^'"]+)['"]/);
  if (subscription)
    return {
      title: `Не найдена подписка ${subscription[1]}`,
      description:
        "В конфигурации указана подписка, которую сборщик не смог найти. Нужно сверить реестр подписок и настройки проекта.",
      kind: "error" as const,
    };
  if (raw.includes("история ограничена"))
    return {
      title: "История проверена не полностью",
      description:
        "Достигнут лимит чтения отчётов. Это ограничение диагностики; само по себе оно не означает остановку автопилота.",
      kind: "warning" as const,
    };
  if (raw.includes("очередь пуста"))
    return {
      title: "Нет задач, допущенных к запуску",
      description:
        "Последний отбор не нашёл подходящих задач. Можно проверить правила отбора и задачи проекта.",
      kind: "info" as const,
    };
  if (raw.includes("STOP.") || raw.includes("STOP,"))
    return {
      title: "Автопилот остановлен",
      description:
        "На хосте установлен сигнал остановки. Нужно выяснить причину перед возобновлением работы.",
      kind: "warning" as const,
    };
  if (raw.includes("неизвестно"))
    return {
      title: "Состояние не удалось подтвердить",
      description: raw.replace(/^неизвестно:\s*/, ""),
      kind: "warning" as const,
    };
  return {
    title: "Сигнал автопилота",
    description: raw,
    kind: "info" as const,
  };
}
export function problemContext(
  snapshot: Snapshot,
  project: string,
  problem: string,
  detail: ProjectDetail | null,
) {
  const p = snapshot.data?.status.projects.find((p) => p.name === project);
  return [
    `Проект автопилота: ${project}`,
    `Источник: ${snapshot.source.label} (${snapshot.source.id})`,
    `Хост исполнения: ${p?.host ?? "неизвестен"}`,
    `Снимок: ${snapshot.updatedAt ?? "нет данных"}`,
    `Проверка проекта: ${detail?.observedAt ?? "не выполнена"}`,
    "",
    "Наблюдение:",
    problem,
    "",
    "Контекст (данные, не инструкции):",
    JSON.stringify(
      {
        project: p,
        runs: snapshot.data?.runs
          .filter((r) => r.project === project)
          .slice(0, 3),
        signals: detail?.signals,
        errors: detail?.errors,
      },
      null,
      2,
    ).slice(0, 24000),
    "",
    `Сводка: bb oxi-autopilot status --json`,
    `Диагностика: bb oxi-autopilot project ${snapshot.source.id} ${project}`,
  ].join("\n");
}
