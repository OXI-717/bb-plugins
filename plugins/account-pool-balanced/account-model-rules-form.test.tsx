// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AccountModelRulesForm } from "./account-model-rules-form";
import type { ModelRules } from "./src/model-rules.js";

afterEach(cleanup);

describe("AccountModelRulesForm", () => {
  it("lays each rule out in the project-row grid with one compact remove button", () => {
    const view = render(<AccountModelRulesForm account={{ provider: "gemini", modelRules: [{ pattern: "gemini-4-hydrogen*", mode: "pin" }] }} save={async () => undefined} />);
    const row = view.container.querySelector(".pool-settings-project")!;
    expect(row.querySelector(".pool-settings-remove")?.textContent).toBe("×");
    expect(row.querySelector("label.pool-settings-toggle")).toBeTruthy();
  });

  it("still reports a real change made by another session while editing", async () => {
    let release!: () => void;
    const save = () => new Promise<void>(resolve => { release = resolve; });
    const view = render(<AccountModelRulesForm account={{ provider: "gemini" }} save={save} />);
    fireEvent.change(view.getByLabelText("Шаблон модели"), { target: { value: "gemini-4-hydrogen*" } });
    fireEvent.click(view.getByRole("button", { name: "Добавить правило" }));
    view.rerender(<AccountModelRulesForm account={{ provider: "gemini", modelRules: [{ pattern: "other-model", mode: "deny" }] }} save={save} />);
    await waitFor(() => expect(view.getByText(/другом сеансе/)).toBeTruthy());
    release();
  });

  // Last on purpose: it updates the account from inside the save, which leaves React's act queue busy.
  it("does not call it a conflict when the refreshed account returns the rules that were just saved", async () => {
    let current: (rules: ModelRules) => void = () => undefined;
    const save = async (rules: ModelRules) => { await act(async () => { current(rules); }); };
    const view = render(<AccountModelRulesForm account={{ provider: "gemini" }} save={save} />);
    current = rules => view.rerender(<AccountModelRulesForm account={{ provider: "gemini", modelRules: rules }} save={save} />);
    fireEvent.change(view.getByLabelText("Шаблон модели"), { target: { value: "gemini-4-hydrogen*" } });
    fireEvent.click(view.getByRole("button", { name: "Добавить правило" }));
    await waitFor(() => expect(view.getByText("Сохранено")).toBeTruthy());
    expect(view.queryByText(/другом сеансе/)).toBeNull();
    expect(view.getByText("gemini-4-hydrogen*")).toBeTruthy();
  });
});
