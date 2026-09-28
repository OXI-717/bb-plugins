import { describe, expect, it } from "vitest";
import { emptyFilters, hostName, matchesFilters, readFilters, stateLabel } from "./filters";
import type { CatalogTask } from "../src/catalog-types";
const task = { id: "daily", name: "Daily", host: "example", scope: "personal", owner: null, team: null, sourceId: "local-bb", scheduler: "bb", projectId: null, state: "unknown", missing: false } as CatalogTask;
describe("catalog filters", () => {
  it("does not treat the legacy BB executor sentinel as a machine", () => {
    const agent = { ...task, host: "BB-managed agent", hostLabel: "prefix-BB-managed agent", projectName: "Example Project" };
    expect(hostName(agent)).toBeNull();
    expect(matchesFilters(agent, { ...emptyFilters, host: "BB-managed agent" })).toBe(false);
    expect(matchesFilters(agent, { ...emptyFilters, query: "Example Project" })).toBe(true);
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => JSON.stringify({ ...emptyFilters, host: "BB-managed agent", project: "project-example" }) } });
    expect(readFilters()).toEqual({ ...emptyFilters, host: "", project: "project-example" });
    Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  it("separates display labels for hosts with the same raw name", () => {
    const labelled = { ...task, hostLabel: "team-example" };
    expect(matchesFilters(labelled, { ...emptyFilters, query: "team-example" })).toBe(true);
    expect(matchesFilters(labelled, { ...emptyFilters, host: "team-example" })).toBe(true);
    expect(matchesFilters(task, { ...emptyFilters, host: "team-example" })).toBe(false);
    expect(matchesFilters(labelled, { ...emptyFilters, host: "example" })).toBe(false);
  });
  it("includes connected BB sources in BB filter", () => { expect(matchesFilters(task, { ...emptyFilters, source: "bb" })).toBe(true); expect(matchesFilters(task, { ...emptyFilters, source: "other" })).toBe(false); });
  it("does not claim an unknown state is healthy", () => { expect(stateLabel(task)).toBe("Состояние не подключено"); });
  it("handles unavailable session storage", () => { expect(readFilters()).toEqual({ ...emptyFilters, state: "current" }); });
  it("restores only validated filter strings", () => {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => JSON.stringify({ ...emptyFilters, source: "bb" }) } });
    expect(readFilters().source).toBe("bb");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => '{"source": 42}' } });
    expect(readFilters()).toEqual({ ...emptyFilters, state: "current" });
    Reflect.deleteProperty(globalThis, "sessionStorage");
  });
});
