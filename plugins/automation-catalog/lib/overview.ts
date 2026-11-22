import type { CatalogTask } from "../src/catalog-types";

export function category(task: CatalogTask) {
  if (task.missing) return "missing";
  if (task.scheduler === "inventory-audit") return "registry";
  if (task.scheduler === "systemd" && task.scheduleKind === "once" && task.executionId) return "executions";
  if (task.history === "not-connected" || task.state === "unknown") return "unmonitored";
  if (task.scheduleKind === "once" && task.state === "paused" && task.lastRun?.status === "succeeded") return "completed";
  if (task.state === "paused") return "paused";
  return "current";
}

export function nextStep(task: CatalogTask) {
  switch (category(task)) {
    case "missing": return "Задачи больше нет в источнике. Историю можно оставить или удалить запись из каталога.";
    case "unmonitored": return "Это описание из реестра. Для проверки работы нужно подключить состояние и историю исходного планировщика.";
    case "executions": return "Разовое исполнение systemd. Его результат и журнал доступны в карточке.";
    case "completed": return "Одноразовая задача завершена. Повторный запуск не запланирован.";
    case "paused": return task.lastRun?.status === "failed"
      ? "Расписание отключено, а последний запуск завершился ошибкой. Откройте его результат и разберите причину перед включением."
      : "Расписание отключено. Включайте его, только если задача должна снова выполняться.";
  }
  if (task.state === "unknown") return "Не удалось подтвердить текущее состояние. Проверьте задачу в исходном планировщике; старый результат не подтверждает, что она запущена сейчас.";
  if (task.state === "failed" || task.state === "blocked" || task.lastRun?.status === "failed") return "Откройте результат последнего запуска. Для разбора причины можно подготовить запрос агенту.";
  return "Откройте последние результаты, чтобы проверить, что задача выполнила нужную работу. Статус планировщика сам по себе этого не гарантирует.";
}

const registryEventText = new Map([
  ["Inventory finding no longer observed", "Предупреждение закрыто"],
  ["Identity classified by explicit registry decision; runtime coverage remains separate", "Задача классифицирована в реестре"],
  ["Observed scheduler entry has no registry record", "Задача не была найдена в реестре"],
  ["Required job absent from fresh scheduler inventory", "Обязательной задачи нет у планировщика"],
  ["Required automation absent from fresh BB inventory", "Обязательной задачи нет в BB"],
  ["Host inventory missing or stale", "Нет свежих данных с машины"],
  ["Scheduler inventory unavailable", "Планировщик не передал данные"],
  ["Expected scheduler scope not observed", "Область планировщика не наблюдалась"],
  ["Catalog source unavailable or stale", "Нет свежих данных источника"],
]);

export function resultText(summary: string) {
  const registryText = registryEventText.get(summary);
  if (registryText) return registryText;
  if (summary === "Skipped: empty output") return "Тихая проверка: скрипт завершился без вывода.";
  if (/^launchd reported execution #\d+, exit code 0\./.test(summary)) return "Последний сохранённый результат: завершено без ошибки. Планировщик не сохранил точное время запуска.";
  const failed = /^launchd reported execution #\d+, exit code (-?\d+)\./.exec(summary);
  if (failed) return `Последний сохранённый результат: ошибка, код выхода ${failed[1]}. Планировщик не сохранил точное время запуска.`;
  if (/^launchd reports execution #\d+ running\./.test(summary)) return "При последней проверке задача выполнялась.";
  return summary;
}
