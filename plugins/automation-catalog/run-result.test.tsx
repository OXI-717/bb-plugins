// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
const { call, toThread } = vi.hoisted(() => ({ call: vi.fn(), toThread: vi.fn() }));
vi.mock("@get-bb/plugin-sdk/app", () => ({ useRpc: () => ({ call }), useBbNavigate: () => ({ toThread }) }));
import { RunResult } from "./run-result";
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("loads only the clicked run and renders imported output as text", async () => {
  call.mockResolvedValue({ status: "failed", output: "<script>unsafe()</script>", error: "Example failure", threadId: "thread_example", truncated: false });
  render(<RunResult taskKey="task_example" runId="run_example" />);
  expect(call).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Открыть результат" }));
  expect(await screen.findByText("Example failure")).toBeTruthy();
  expect(screen.getByText("<script>unsafe()</script>")).toBeTruthy();
  expect(document.querySelector("script")).toBeNull();
  expect(call).toHaveBeenCalledWith("catalog_run_result", { key: "task_example", runId: "run_example" });
  fireEvent.click(screen.getByRole("button", { name: "Открыть тред этого запуска" }));
  expect(toThread).toHaveBeenCalledWith("thread_example");
});
it("allows retry after a read failure", async () => {
  call.mockRejectedValueOnce(new Error("Source unavailable")).mockResolvedValueOnce({ status: "succeeded", output: null, error: null, threadId: null, truncated: false });
  render(<RunResult taskKey="task_example" runId="run_example" />);
  fireEvent.click(screen.getByRole("button", { name: "Открыть результат" }));
  fireEvent.click(await screen.findByRole("button", { name: "Повторить" }));
  expect(await screen.findByText("Текстовый вывод не сохранён.")).toBeTruthy();
});
