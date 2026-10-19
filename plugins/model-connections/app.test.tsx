// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  ExperimentalProviderModelPickerValue,
  NewThreadComposerProps,
} from "@get-bb/plugin-sdk/app";
import { classifyConnections } from "./catalog";
import { ConnectionsPanel } from "./app";
const state = vi.hoisted(() => ({ call: vi.fn(), toThread: vi.fn() }));
const client = { call: state.call };
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (setup: unknown) => setup,
  useRpc: () => client,
  useBbNavigate: () => ({ toThread: state.toThread }),
  experimental_Icon: () => null,
  experimental_ProviderIcon: () => null,
  experimental_ProviderModelPicker: ({
    value,
    onChange,
  }: {
    value: ExperimentalProviderModelPickerValue;
    onChange: (value: ExperimentalProviderModelPickerValue) => void;
  }) => (
    <button onClick={() => onChange({ ...value, model: "test-model" })}>
      Выбрать тестовую модель
    </button>
  ),
  experimental_NewThreadComposer: ({
    onSubmit,
    defaultProviderId,
    defaultModel,
    initialPrompt,
  }: NewThreadComposerProps) => (
    <div>
      <p>{initialPrompt}</p>
      <button
        onClick={() =>
          void Promise.resolve(
            onSubmit({
              projectId: "project-one",
              providerId: defaultProviderId!,
              model: defaultModel!,
              reasoningLevel: "medium",
              permissionMode: "auto",
              executionInputSources: {
                providerId: "explicit",
                model: "explicit",
                reasoningLevel: "explicit",
              },
              environment: { type: "reuse", environmentId: "environment-one" },
              input: [{ type: "text", text: "User draft", mentions: [] }],
            }),
          ).catch(() => {})
        }
      >
        Отправить новый тред
      </button>
    </div>
  ),
}));
const snapshot = () => ({
  hostId: "host-one",
  hosts: [{ id: "host-one", name: "Test machine" }],
  environmentId: "environment-one",
  projectId: "project-one",
  currentProviderId: "codex",
  poolAvailable: true,
  connections: classifyConnections(
    [
      {
        id: "codex",
        name: "Codex",
        available: true,
        logoUrl: null,
        icon: "Bot",
      },
      {
        id: "acp-cursor",
        name: "Cursor",
        available: true,
        logoUrl: null,
        icon: "Bot",
      },
      { id: "pi", name: "Pi", available: true, logoUrl: null, icon: "Bot" },
    ],
    new Map([
      ["codex", "ready"],
      ["acp-cursor", "ready"],
      ["pi", "not_installed"],
    ]),
    {
      routing: { codex: true },
      accounts: [{ provider: "codex", enabled: true }],
    },
    [],
    null,
  ),
});
beforeEach(() => {
  localStorage.clear();
  state.call.mockReset();
  state.toThread.mockReset();
  state.call.mockImplementation(async (method: string) =>
    method === "catalog"
      ? snapshot()
      : method === "create"
        ? { threadId: "new-thread" }
        : { ok: true },
  );
});
afterEach(cleanup);
describe("separate model chooser", () => {
  it("retains the submitted request ID when the native draft is restored after remount", async () => {
    state.call.mockImplementation(async (method: string) =>
      method === "catalog"
        ? snapshot()
        : method === "create"
          ? Promise.reject(Error("reply lost"))
          : { ok: true },
    );
    const first = render(<ConnectionsPanel threadId="thread-one" />);
    async function submit() {
      fireEvent.click(await screen.findByRole("button", { name: /^Cursor/ }));
      fireEvent.click(screen.getByText("Выбрать тестовую модель"));
      fireEvent.click(screen.getByText("Продолжить в новом треде"));
      fireEvent.click(screen.getByText("Отправить новый тред"));
    }
    await submit();
    await waitFor(() =>
      expect(
        state.call.mock.calls.filter((x) => x[0] === "create"),
      ).toHaveLength(1),
    );
    const id = state.call.mock.calls.find((x) => x[0] === "create")?.[1]
      .requestId;
    first.unmount();
    render(<ConnectionsPanel threadId="thread-one" />);
    await submit();
    await waitFor(() =>
      expect(
        state.call.mock.calls.filter((x) => x[0] === "create"),
      ).toHaveLength(2),
    );
    expect(
      state.call.mock.calls.filter((x) => x[0] === "create")[1][1].requestId,
    ).toBe(id);
  });
  it("separates local and pooled connections and collapses unavailable entries", async () => {
    render(<ConnectionsPanel threadId="thread-one" />);
    await screen.findByRole("heading", { name: /Локальные подключения/ });
    expect(screen.getByRole("heading", { name: /Pooler/ })).toBeTruthy();
    expect(screen.getByText(/Скрытые и недоступные/)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^Pi/ }).hasAttribute("disabled"),
    ).toBe(true);
  });
  it("applies a selection without sending or creating a thread", async () => {
    render(<ConnectionsPanel threadId="thread-one" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Codex/ }));
    fireEvent.click(screen.getByText("Выбрать тестовую модель"));
    fireEvent.click(screen.getByText("Применить со следующего хода"));
    await screen.findByText(
      "Модель выбрана. Она применится со следующего хода.",
    );
    expect(state.call).toHaveBeenCalledWith("apply", {
      threadId: "thread-one",
      providerId: "codex",
      model: "test-model",
      reasoningLevel: "medium",
      expectedGroup: "pool",
    });
    expect(state.call.mock.calls.some((x) => x[0] === "create")).toBe(false);
  });
  it("requires an explicit new-thread submission for a different engine", async () => {
    render(<ConnectionsPanel threadId="thread-one" />);
    fireEvent.click(await screen.findByRole("button", { name: /^Cursor/ }));
    fireEvent.click(screen.getByText("Выбрать тестовую модель"));
    expect(screen.queryByText("Применить со следующего хода")).toBeNull();
    fireEvent.click(screen.getByText("Продолжить в новом треде"));
    expect(state.call.mock.calls.some((x) => x[0] === "create")).toBe(false);
    expect(
      screen.getByText(/Continue the work from @thread:thread-one/),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Отправить новый тред"));
    await waitFor(() =>
      expect(state.toThread).toHaveBeenCalledWith("new-thread"),
    );
    expect(
      state.call.mock.calls.find((x) => x[0] === "create")?.[1],
    ).toMatchObject({
      expectedProviderId: "acp-cursor",
      expectedGroup: "local",
      sourceThreadId: "thread-one",
    });
  });
  it("Refresh performs a new read and shows errors instead of stale success", async () => {
    render(<ConnectionsPanel threadId="thread-one" />);
    await screen.findByRole("button", { name: /^Codex/ });
    state.call.mockRejectedValueOnce(Error("offline"));
    fireEvent.click(
      screen.getByRole("button", { name: "Обновить подключения" }),
    );
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: /^Codex/ })).toBeNull();
    expect(
      state.call.mock.calls.filter((x) => x[0] === "catalog"),
    ).toHaveLength(2);
  });
  it("hiding affects chooser preferences only", async () => {
    render(<ConnectionsPanel threadId="thread-one" />);
    await screen.findByRole("button", { name: /^Codex/ });
    fireEvent.click(screen.getByRole("button", { name: "Скрыть Cursor" }));
    await waitFor(() =>
      expect(state.call).toHaveBeenCalledWith("visibility", {
        hostId: "host-one",
        providerId: "acp-cursor",
        hidden: true,
      }),
    );
    expect(
      state.call.mock.calls.some((x) => /disable|routing|bypass/.test(x[0])),
    ).toBe(false);
  });
});
