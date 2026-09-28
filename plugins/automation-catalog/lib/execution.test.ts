import { describe, expect, it } from "vitest";
import { modelLabel, projectLabel, unlinkedProject } from "./execution";
import { emptyFilters, matchesFilters } from "./filters";
import type { CatalogTask } from "../src/catalog-types";
const task = { name: "Example", id: "example", projectId: null, host: "worker", executor: "python3" } as CatalogTask;
describe("execution and project transparency", () => {
  it("never treats scripts as proof of no model costs", () => {
    expect(modelLabel(task)).toBe("Вызовы моделей не проверены");
    expect(modelLabel({ ...task, executor: "agent" })).toContain("не передана");
  });
  it("distinguishes configured and inherited models", () => {
    const agent = { model: "example-model", provider: "example-provider", reasoning: "high", serviceTier: "fast", modelSource: "automation" as const };
    expect(modelLabel({ ...task, agent })).toBe("Модель: example-model · example-provider");
    expect(modelLabel({ ...task, agent: { ...agent, modelSource: "existing-thread" } })).toContain("Модель из треда");
    expect(matchesFilters({ ...task, agent }, { ...emptyFilters, query: "example-model" })).toBe(true);
  });
  it("makes unlinked and personal projects distinguishable without inventing IDs", () => {
    expect(projectLabel(task)).toBe("Без привязки к проекту");
    expect(projectLabel({ ...task, projectName: "External" })).toBe("External · без привязки к BB");
    expect(projectLabel({ ...task, projectId: "proj_personal", projectName: "Personal" })).toBe("Личные автоматизации (Personal)");
    expect(matchesFilters(task, { ...emptyFilters, project: unlinkedProject })).toBe(true);
    expect(matchesFilters({ ...task, projectId: "project-example" }, { ...emptyFilters, project: unlinkedProject })).toBe(false);
  });
});
