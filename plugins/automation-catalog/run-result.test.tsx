// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const { call, toThread } = vi.hoisted(() => ({ call: vi.fn(), toThread: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => ({ call }), useBbNavigate: () => ({ toThread }) }));
import { RunResult } from "./run-result";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("loads only the clicked run and opens its native thread without rendering raw output", async () => {
  call.mockResolvedValue({ status: "failed", hasOutput: true, hasError: true, output: "<script>unsafe()</script>", threadId: "thread_example", nativeUrl: "/plugins/automations/automations/proj_example/auto_example" });
  render(<RunResult taskKey="task_example" runId="run_example" />);
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Открыть результат" }));
  expect(await screen.findByText("Вывод этого запуска доступен в BB.")).toBeTruthy();
  expect(screen.queryByText("<script>unsafe()</script>")).toBeNull();
  expect(document.querySelector("script")).toBeNull();
  expect(call).toHaveBeenCalledWith("catalog_run_result", { key: "task_example", runId: "run_example" });
  fireEvent.click(screen.getByRole("button", { name: "Открыть тред этого запуска" }));
  expect(toThread).toHaveBeenCalledWith("thread_example");
});
it("allows retry after a read failure", async () => {
  call.mockRejectedValueOnce(new Error("Source unavailable")).mockResolvedValueOnce({ status: "succeeded", hasOutput: false, hasError: false, threadId: null, nativeUrl: "/plugins/automations/automations/proj_example/auto_example" });
  render(<RunResult taskKey="task_example" runId="run_example" />);
  fireEvent.click(screen.getByRole("button", { name: "Открыть результат" }));
  fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
  expect(await screen.findByText("Текстовый вывод не сохранён.")).toBeTruthy();
});
