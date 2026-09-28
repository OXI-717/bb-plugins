import { describe, it, expect } from "vitest";
import { category, nextStep, resultText } from "./overview";
import type { CatalogTask } from "../src/catalog-types";
const task = { state: "active", history: "available", missing: false, lastRun: null } as CatalogTask;
describe("operational overview", () => {
  it("keeps current tasks separate from inventory, history and pauses", () => {
    expect(category(task)).toBe("current");
    expect(category({ ...task, state: "unknown", history: "not-recorded" })).toBe("current");
    expect(category({ ...task, history: "not-connected" })).toBe("unmonitored");
    expect(category({ ...task, state: "paused" })).toBe("paused");
    expect(category({ ...task, state: "paused", scheduleKind: "once", lastRun: { status: "succeeded" } as CatalogTask["lastRun"] })).toBe("completed");
    expect(category({ ...task, missing: true })).toBe("missing");
  });
  it("explains what to check without claiming a healthy outcome", () => {
    expect(nextStep({ ...task, state: "unknown" })).toContain("старый результат не подтверждает");
    expect(nextStep({ ...task, history: "not-connected" })).toContain("подключить состояние");
  });
  it("translates known collector receipts without discarding other evidence", () => {
    expect(resultText("Skipped: empty output")).toContain("Тихая проверка");
    expect(resultText("launchd reported execution #12, exit code 0. More text")).not.toContain("#12");
    expect(resultText("Unexpected failure")).toBe("Unexpected failure");
  });
});
