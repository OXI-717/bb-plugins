import { describe, it, expect } from "vitest";
import { health, creationPrompt, attentionFingerprint } from "./operations";
import { catalogSchedule } from "./catalog-schedule";
import type { CatalogTask } from "../src/catalog-types";
const task = { state: "active", missing: false, lastRun: null } as CatalogTask;
describe("incident review", () => {
  const failed = { ...task, history: "available", lastRun: { id: "run-a", status: "failed", finishedAt: 1, exitCode: 1 } } as CatalogTask;
  it("keeps an old weekly failure actionable", () => {
    expect(health(failed, undefined, 30 * 86400000).attention).toBe(true);
  });
  it("separates unknown state from failed execution", () => {
    expect(health({ ...task, state: "unknown", history: "available" }).attention).toBe(false);
    expect(health({ ...failed, state: "unknown" }).attention).toBe(true);
  });
  it("reviews only one incident and reopens on a new failure", () => {
    const reviewed = { ...failed, review: { fingerprint: attentionFingerprint(failed), note: "Checked", at: 10 } };
    expect(health(reviewed)).toMatchObject({ attention: false, label: "Разобрано" });
    expect(health({ ...reviewed, lastRun: { ...failed.lastRun!, id: "run-b" } }).attention).toBe(true);
    expect(health({ ...reviewed, lastRun: { ...failed.lastRun!, id: "run-b", status: "succeeded" } }).attention).toBe(false);
  });
});
describe("operational state", () => {
  it("keeps source deletions visible without counting them as running failures", () => {
    expect(health({ ...task, missing: true })).toMatchObject({
      label: "Отсутствует", attention: false, tone: "danger",
    });
  });
  it("surfaces failed executions despite an enabled schedule", () => {
    expect(
      health({
        ...task,
        lastRun: { status: "failed" } as CatalogTask["lastRun"],
      }),
    ).toMatchObject({ label: "Последний запуск завершился ошибкой", attention: true });
  });
  it("keeps unverified registry blockers out of the actionable count", () => {
    expect(
      health({ ...task, state: "unknown", history: "not-connected", declaredState: "blocked" }),
    ).toMatchObject({ label: "Только описание", attention: false });
  });
  it("does not treat a deliberate pause as failure", () => {
    expect(health({ ...task, state: "paused" })).toMatchObject({
      label: "Отключена",
      attention: false,
      paused: true,
    });
  });
  it("shows a completed one-shot separately from paused schedules", () => {
    expect(health({ ...task, state: "paused", scheduleKind: "once", lastRun: { status: "succeeded" } as CatalogTask["lastRun"] }))
      .toMatchObject({ label: "Завершена", paused: false, attention: false });
  });
  it("does not equate scheduler success with validated output", () => {
    expect(health({ ...task, lastRun: { status: "succeeded", hasOutput: true } as CatalogTask["lastRun"] }).reason)
      .toContain("Вывод не проверен");
  });
  it("does not hide a failure behind a pause", () => {
    expect(
      health({
        ...task,
        state: "paused",
        lastRun: { status: "failed" } as CatalogTask["lastRun"],
      }),
    ).toMatchObject({ attention: true, paused: true });
  });
  it("does not invent healthy state without monitoring", () => {
    expect(
      health({ ...task, state: "unknown", history: "not-connected", declaredState: "active" }),
    ).toMatchObject({ label: "Только описание", attention: false });
  });
  it("routes creation by scope and execution destination", () => {
    expect(creationPrompt("bb", "personal")).toContain(
      "установленный скилл automations",
    );
    expect(creationPrompt("local", "personal")).toContain("oxi-launchd");
    expect(creationPrompt("server", "team")).toContain("командную автоматизацию");
    expect(creationPrompt("server", "team")).toContain(
      "Не заменяй выбранный планировщик",
    );
  });
});
describe("freshness and registry signals", () => {
  it("shows stale source warning alongside a blocker", () => {
    expect(
      health(
        { ...task, state: "blocked" },
        {
          id: "test",
          name: "Test",
          checkedAt: 1,
          lastSuccessAt: 1,
          staleAfterMs: 60000,
          error: "offline",
        },
        100000,
      ).reason,
    ).toContain("Ошибка связи с источником");
  });
  it("shows registry failure as unverified metadata", () => {
    expect(
      health({ ...task, state: "unknown", history: "not-connected", declaredState: "failed" }),
    ).toMatchObject({
      label: "Только описание",
      reason: "В реестре указано: Ошибка. Фактическое состояние не подключено.",
      attention: false,
    });
  });
  it("requires fresh source evidence before calling a task overdue", () => {
    const source = {
      id: "test",
      name: "Test",
      checkedAt: 200000,
      lastSuccessAt: 200000,
      staleAfterMs: 60000,
      error: null,
    };
    expect(health({ ...task, nextRunAt: 1 }, source, 200000).label).toBe(
      "Просрочена",
    );
    expect(health({ ...task, state: "unknown", nextRunAt: 1 }, source, 200000).attention).toBe(false);
    expect(health({ ...task, state: "unknown", nextRunAt: 1, lastRun: { status: "failed" } as CatalogTask["lastRun"] }, source, 200000).attention).toBe(true);
    expect(
      health({ ...task, nextRunAt: 1 }, { ...source, lastSuccessAt: 1 }, 200000)
        .label,
    ).toBe("Данные устарели");
    expect(
      health({ ...task, state: "paused", nextRunAt: 1 }, source, 200000).label,
    ).toBe("Отключена");
  });
});
describe("human schedules", () => {
  it("explains event schedules without inferring activation from prose", () => {
    expect(catalogSchedule(JSON.stringify({ kind: "event", description: "example cron disabled" })))
      .toBe("По событию / вручную · условия в описании расписания");
    expect(catalogSchedule('{"kind":"unsupported"}')).not.toContain("{");
    expect(catalogSchedule('{invalid')).not.toContain("{");
  });
  it("reads full daily calendar values", () => {
    expect(catalogSchedule(JSON.stringify({ kind: "calendar", value: "*-*-* 03:00:00 UTC" })))
      .toBe("Ежедневно в 03:00 · UTC");
  });
  it("reads cron with its timezone", () => {
    expect(catalogSchedule("*/15 * * * * Europe/Paris")).toBe(
      "Каждые 15 минут · Europe/Paris",
    );
  });
  it("reads one-shot times", () => {
    expect(catalogSchedule("2026-01-01T10:00:00Z")).toMatch(/^Однократно · /);
  });
  it("preserves unsupported definitions for inspection", () => {
    expect(catalogSchedule("on deployment")).toBe("on deployment");
  });
});
