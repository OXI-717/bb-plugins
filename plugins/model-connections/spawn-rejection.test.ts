import { describe, expect, it } from "vitest";
import { knownSpawnRejection } from "./spawn-rejection";
const http = (status = 400, code = "invalid_request") =>
  Object.assign(Error("Rejected"), {
    name: "BbHttpError",
    status,
    code,
    body: { code, message: "Rejected" },
  });
describe("authoritative BB validation rejection", () => {
  it.each([
    [400, "invalid_request"],
    [404, "project_not_found"],
    [404, "attachment_not_found"],
    [422, "validation_error"],
  ])("accepts confirmed HTTP%s/%s", (status, code) => {
    expect(knownSpawnRejection(http(status, code))).toBe(true);
  });
  it.each([408, 409, 429, 500, 502, 503, 504])(
    "preserves uncertain HTTP%s",
    (status) => {
      expect(knownSpawnRejection(http(status))).toBe(false);
    },
  );
  it("does not infer a rejection from error text or nested causes", () => {
    expect(knownSpawnRejection(Error("HTTP 400 invalid_request"))).toBe(false);
    expect(
      knownSpawnRejection(
        Object.assign(Error("lost reply"), { cause: http() }),
      ),
    ).toBe(false);
    expect(knownSpawnRejection({ ...http(), name: "ProviderError" })).toBe(
      false,
    );
    expect(
      knownSpawnRejection({ ...http(), body: { code: "different" } }),
    ).toBe(false);
  });
});
