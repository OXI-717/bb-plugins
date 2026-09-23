import { describe, it, expect } from "vitest";
import { health, creationPrompt } from "./operations";
import { catalogSchedule } from "./catalog-schedule";
import type { CatalogTask } from "../src/catalog-types";
const task = { state: "active", missing: false, lastRun: null } as CatalogTask;
describe("operational state", () => {
  it("surfaces failed executions despite an enabled schedule", () => {
    expect(
      health({
        ...task,
        lastRun: { status: "failed" } as CatalogTask["lastRun"],
      }),
    ).toMatchObject({ label: "Last run failed", attention: true });
  });
  it("surfaces declared blockers when live monitoring is absent", () => {
    expect(
      health({ ...task, state: "unknown", declaredState: "blocked" }),
    ).toMatchObject({ label: "Blocked", attention: true });
  });
  it("does not treat a deliberate pause as failure", () => {
    expect(health({ ...task, state: "paused" })).toMatchObject({
      label: "Paused",
      attention: false,
      paused: true,
    });
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
      health({ ...task, state: "unknown", declaredState: "active" }),
    ).toMatchObject({ label: "Not monitored", attention: true });
  });
  it("routes creation by scope and execution destination", () => {
    expect(creationPrompt("bb", "personal")).toContain(
      "installed automations skill",
    );
    expect(creationPrompt("local", "personal")).toContain("oxi-launchd");
    expect(creationPrompt("server", "team")).toContain("team automation");
    expect(creationPrompt("server", "team")).toContain(
      "Do not substitute another scheduler",
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
    ).toContain("Source connection problem");
  });
  it("recognizes a registry failure without claiming live verification", () => {
    expect(
      health({ ...task, state: "unknown", declaredState: "failed" }),
    ).toMatchObject({
      label: "Failed",
      reason: "Marked failed in the registry",
      attention: true,
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
      "Overdue",
    );
    expect(
      health({ ...task, nextRunAt: 1 }, { ...source, lastSuccessAt: 1 }, 200000)
        .label,
    ).toBe("Data out of date");
    expect(
      health({ ...task, state: "paused", nextRunAt: 1 }, source, 200000).label,
    ).toBe("Paused");
  });
});
describe("human schedules", () => {
  it("reads cron with its timezone", () => {
    expect(catalogSchedule("*/15 * * * * Europe/Paris")).toBe(
      "Every 15 minutes · Europe/Paris",
    );
  });
  it("reads one-shot times", () => {
    expect(catalogSchedule("2026-01-01T10:00:00Z")).toMatch(/^Once · /);
  });
  it("preserves unsupported definitions for inspection", () => {
    expect(catalogSchedule("on deployment")).toBe("on deployment");
  });
});
