import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: vi.fn(),
  useRealtime: vi.fn(),
}));
import { CatalogDetailContent } from "./detail";
import type { CatalogDetail } from "./src/catalog-types";
const fixture: CatalogDetail = {
  source: {
    id: "test",
    name: "Test source",
    staleAfterMs: 60000,
    checkedAt: 1,
    lastSuccessAt: 1,
    error: "Source unavailable",
  },
  task: {
    id: "daily",
    key: "ext_test",
    sourceId: "test",
    name: "Daily task",
    host: "example",
    scope: "team",
    owner: null,
    team: "Example",
    projectId: null,
    scheduler: "cron",
    executor: "python",
    schedule: null,
    state: "unknown",
    description: "Synthetic task",
    history: "not-connected",
    url: null,
    observedAt: 1,
    missing: false,
    lastRun: null,
  },
  runs: [],
  total: 0,
};
describe("detail failure states", () => {
  it("shows stale failed sources without inventing history or live state", () => {
    const html = renderToStaticMarkup(
      <CatalogDetailContent detail={fixture} />,
    );
    expect(html).toContain("Ошибка соединения");
    expect(html).toContain("Source unavailable");
    expect(html).toContain("Источник не передаёт историю запусков.");
    expect(html).toContain("Не удалось обновить источник");
  });
  it("escapes imported text and reports missing tasks", () => {
    const html = renderToStaticMarkup(
      <CatalogDetailContent
        detail={{
          ...fixture,
          source: { ...fixture.source, managedHere: true },
          task: {
            ...fixture.task,
            missing: true,
            scheduler: "bb",
            projectId: "proj_example",
            description: "<script>alert(1)</script>",
          },
        }}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("нет в последнем снимке источника");
    expect(html).not.toContain("Открыть автоматизацию в BB");
  });
  it("links BB failures to the source without copying script output", () => {
    const html = renderToStaticMarkup(
      <CatalogDetailContent detail={{ ...fixture, source: { ...fixture.source, managedHere: true }, task: {
        ...fixture.task,
        sourceId: "bb-main",
        scheduler: "bb",
        projectId: "proj_example",
        lastRun: {
          id: "run1", taskId: "daily", host: "example", status: "failed",
          startedAt: 1, finishedAt: 2, summary: null, exitCode: 1,
          evidence: "execution", observedAt: null,
        },
      } }} />,
    );
    expect(html).toContain("/plugins/automations/automations/proj_example/daily");
    expect(html).toContain("код 1");
    expect(html).toContain("Каталог не копирует вывод скрипта");
  });
});
