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
    expect(html).toContain("История запусков не подключена.");
    expect(html).toContain("Не удалось обновить источник");
  });
  it("escapes imported text and reports missing tasks", () => {
    const html = renderToStaticMarkup(
      <CatalogDetailContent
        detail={{
          ...fixture,
          task: {
            ...fixture.task,
            missing: true,
            description: "<script>alert(1)</script>",
          },
        }}
      />,
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("нет в последнем снимке источника");
  });
});
