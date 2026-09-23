import { describe, expect, it } from "vitest";
import { emptyFilters, matchesFilters, readFilters, stateLabel } from "./filters";
import type { CatalogTask } from "../src/catalog-types";
const task = { id: "daily", name: "Daily", host: "example", scope: "personal", owner: null, team: null, sourceId: "local-bb", scheduler: "bb", projectId: null, state: "unknown", missing: false } as CatalogTask;
describe("catalog filters", () => {
  it("includes connected BB sources in BB filter", () => { expect(matchesFilters(task, { ...emptyFilters, source: "bb" })).toBe(true); expect(matchesFilters(task, { ...emptyFilters, source: "other" })).toBe(false); });
  it("does not claim an unknown state is healthy", () => { expect(stateLabel(task)).toBe("Live status not connected"); });
  it("handles unavailable session storage", () => { expect(readFilters()).toEqual(emptyFilters); });
  it("restores only validated filter strings", () => {
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => JSON.stringify({ ...emptyFilters, source: "bb" }) } });
    expect(readFilters().source).toBe("bb");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: () => '{"source": 42}' } });
    expect(readFilters()).toEqual(emptyFilters);
    Reflect.deleteProperty(globalThis, "sessionStorage");
  });
});
