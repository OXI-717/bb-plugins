// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuditCard, AuditPanel } from "./audit";
import type { AuditRecord } from "./src/audit-types";
const call = vi.hoisted(() => vi.fn());
const rpc = { call };
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => rpc, useRealtime: () => {}, useBbNavigate: () => ({ toThread: vi.fn(), toPluginPanel: vi.fn() }) }));
afterEach(() => { cleanup(); call.mockReset(); });
it("shows retained history and escapes imported content and unsafe evidence links", () => {
  const record: AuditRecord = { id: "entry", key: "ext_example", recordedAt: 2000, checkedAt: 1000, kind: "audit",
    task: { id: "daily", name: "Daily", sourceId: "example", host: "example", projectId: null },
    outcome: "partial", decision: "defer", summary: "<script>bad()</script>", checks: "Static only", changes: "", remaining: "Execution pending",
    evidence: ["javascript:alert(1)", "https://example.com/proof"], authorThreadId: null };
  const { container } = render(<AuditCard record={record} presentInCatalog={false} />);
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("<script>bad()</script>")).toBeTruthy();
  expect(screen.getByText(/Карточка удалена/)).toBeTruthy();
  expect(container.querySelectorAll("a")).toHaveLength(1);
  expect(container.querySelector("a")?.href).toBe("https://example.com/proof");
});
it("keeps the same request identity after an uncertain save and preserves the form", async () => {
  call.mockImplementation(async (name: string) => {
    if (name === "catalog_audit_list") return { records: [], total: 0 };
    throw new Error("Response lost");
  });
  render(<AuditPanel taskKey="ext_example" />);
  fireEvent.click(screen.getByText("Добавить запись"));
  fireEvent.change(screen.getByLabelText("Краткий итог"), { target: { value: "Inspected" } });
  fireEvent.change(screen.getByLabelText("Что и как проверено"), { target: { value: "Read inputs" } });
  fireEvent.click(screen.getByText("Сохранить запись"));
  await screen.findByText("Response lost");
  await waitFor(() => expect((screen.getByText("Сохранить запись") as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByText("Сохранить запись"));
  await waitFor(() => expect(call.mock.calls.filter(c => c[0] === "catalog_audit_append")).toHaveLength(2));
  const attempts = call.mock.calls.filter(c => c[0] === "catalog_audit_append");
  expect(attempts[0][1]).toEqual(attempts[1][1]);
  expect(attempts[0][1]).toMatchObject({ outcome: "not-run", decision: "undecided", checks: "Read inputs" });
});
