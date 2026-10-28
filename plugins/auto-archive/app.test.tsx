// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const { sdk } = vi.hoisted(() => ({ sdk: {threads: {
  getPluginMetadata: vi.fn(), updatePluginMetadata: vi.fn(),
}} }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useSdk: () => sdk, definePluginApp: (factory: unknown) => factory,
}));
import { PermanentThread } from "./app.js";
afterEach(cleanup);
it("a late focus refresh cannot undo the saved checkbox state", async () => {
  sdk.threads.getPluginMetadata.mockResolvedValueOnce({permanent: true});
  sdk.threads.updatePluginMetadata.mockResolvedValue({permanent: false});
  render(<PermanentThread threadId="thr_example" />);
  const checkbox = screen.getByRole("checkbox", {name: "Постоянный тред"}) as HTMLInputElement;
  await waitFor(() => expect(checkbox.checked).toBe(true));
  let finishRefresh!: (value: {permanent: boolean}) => void;
  sdk.threads.getPluginMetadata.mockImplementationOnce(() => new Promise(resolve => { finishRefresh = resolve; }));
  fireEvent.focus(window);
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.checked).toBe(false));
  await act(async () => { finishRefresh({permanent: true}); });
  expect(checkbox.checked).toBe(false);
  expect(sdk.threads.updatePluginMetadata).toHaveBeenCalledWith({threadId: "thr_example", set: {permanent: false}});
});
