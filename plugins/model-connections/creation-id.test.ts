// @vitest-environment jsdom
import { beforeEach, describe, it, expect } from "vitest";
import { completeRequestId, requestIdFor } from "./creation-id";
beforeEach(() => localStorage.clear());
describe("durable creation identity", () => {
  it("retains the request across component generations and page reload storage reads", () => {
    const first = requestIdFor(localStorage, "thread:host:provider");
    expect(requestIdFor(localStorage, "thread:host:provider")).toBe(first);
  });
  it("does not clear an uncertain request, and scopes drafts independently", () => {
    const id = requestIdFor(localStorage, "one");
    expect(requestIdFor(localStorage, "two")).not.toBe(id);
    expect(requestIdFor(localStorage, "one")).toBe(id);
    completeRequestId(localStorage, "one", "different");
    expect(requestIdFor(localStorage, "one")).toBe(id);
  });
  it("rotates only after a confirmed completion", () => {
    const id = requestIdFor(localStorage, "one");
    completeRequestId(localStorage, "one", id);
    expect(requestIdFor(localStorage, "one")).not.toBe(id);
  });
  it("refuses to submit when durable storage is unavailable or corrupted", () => {
    expect(() =>
      requestIdFor(
        {
          getItem: () => null,
          setItem: () => {
            throw Error("storage unavailable");
          },
        },
        "one",
      ),
    ).toThrow();
    localStorage.setItem("model-connections-request:one", "broken");
    expect(() => requestIdFor(localStorage, "one")).toThrow();
  });
});
