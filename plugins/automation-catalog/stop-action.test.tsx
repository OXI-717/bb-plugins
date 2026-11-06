// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CatalogDetail } from "./src/catalog-types";
import { externalStopIntent } from "./lib/stop-intent";
const { call, composer } = vi.hoisted(() => ({ call: vi.fn(), composer: vi.fn() }));
const rpc = { call };
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useRpc: () => rpc, useRealtime: () => {}, useBbNavigate: () => ({ toThread: vi.fn() }),
  experimental_NewThreadComposer: (props: unknown) => { composer(props); return <div>Editable composer</div>; },
}));
import { CatalogDetailView } from "./detail";
const detail: CatalogDetail = {
  source: { id: "example-systemd", name: "Example service source", staleAfterMs: 60000, checkedAt: 1, lastSuccessAt: 1, error: null },
  task: { id: "system:example.timer", key: "ext_example", sourceId: "example-systemd", name: "Example timer", host: "host-example", scope: "personal", owner: "Owner", team: null, projectId: null, scheduler: "systemd", executor: "service", schedule: "hourly", state: "active", description: "Registered exact timer and companion", history: "available", url: null, observedAt: 1, missing: false, lastRun: null },
  runs: [], total: 0,
};
afterEach(() => { cleanup(); call.mockReset(); composer.mockReset(); });
it("opens an editable parent-bound draft without submitting a model or changing scheduler state", async () => {
  call.mockImplementation(async (method: string) => {
    if (method === "catalog_detail") return detail;
    if (method === "catalog_audit_list") return { records: [], total: 0 };
    if (method === "catalog_compose_context") return { parentThreadId: "thread_example", parentTitle: "Catalog", projectId: "project_example" };
    throw new Error(`Unexpected mutation: ${method}`);
  });
  render(<CatalogDetailView taskKey={detail.task.key} onBack={() => {}} />);
  fireEvent.click(await screen.findByText("Подготовить отключение"));
  await screen.findByText("Editable composer");
  expect(call.mock.calls.every(([method]) => ["catalog_detail", "catalog_audit_list", "catalog_compose_context"].includes(method))).toBe(true);
  expect(composer.mock.lastCall?.[0]).toMatchObject({ defaultProjectId: "project_example", initialPrompt: externalStopIntent(detail)?.prompt });
  expect(externalStopIntent(detail)?.prompt).toContain("catalog_audit_append");
});
it("uses the underlying identity for unregistered findings rather than stopping the inventory auditor", () => {
  const finding = { ...detail, task: { ...detail.task, id: "finding-example", scheduler: "inventory-audit", description: 'Observed scheduler entry has no registry record. Identity: ["host-example","systemd","user","example.service"]. No automatic stop. Inspect original scheduler before disabling.' } };
  const intent = externalStopIntent(finding)!;
  expect(intent.prompt).toContain('"identity":{"host":"host-example","scheduler":"systemd","scope":"user","id":"example.service"}');
  expect(intent.taskKey).toBe(detail.task.key);
});
it.each(["Host inventory missing or stale. Identity: host-example. No automatic stop.", 'Scheduler inventory unavailable. Identity: ["host-example","systemd","system","*"]. No automatic stop.', "Previous inventory finding recovered.", 'Identity: ["host-example","systemd","user","example.service"]'])
  ("does not offer a stop target for coverage, malformed or resolved findings (%s)", description => {
    expect(externalStopIntent({ ...detail, task: { ...detail.task, scheduler: "inventory-audit", description } })).toBeNull();
  });
it("does not prepare a stop for a task missing from its source", () => {
  expect(externalStopIntent({ ...detail, task: { ...detail.task, missing: true } })).toBeNull();
});
