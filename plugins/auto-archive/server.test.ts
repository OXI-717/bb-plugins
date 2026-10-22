import { it, expect, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import plugin from "./server.js";
it("starts observation-only and preserves install timestamp across reloads", async () => {
  let definitions: Record<string, { default: unknown }> = {};
  const data = new Map<string, unknown>();
  const service = vi.fn();
  const register = vi.fn();
  const bb = {
    settings: {
      define: (defs: typeof definitions) => {
        definitions = defs;
        return {
          get: async () =>
            Object.fromEntries(
              Object.entries(defs).map(([k, v]) => [k, v.default]),
            ),
        };
      },
    },
    storage: {
      kv: {
        get: async (key: string) => data.get(key),
        set: async (key: string, value: unknown) => {
          data.set(key, value);
        },
      },
    },
    background: { service },
    cli: { register },
  } as unknown as BbPluginApi;
  await plugin(bb);
  expect(definitions.dryRun.default).toBe(true);
  expect(definitions.inactivityDays.default).toBe("14");
  expect(definitions.detachActiveDescendants.default).toBe(false);
  expect(definitions.keepThreadIds.default).toBe("[]");
  const first = data.get("installed-at");
  await plugin(bb);
  expect(data.get("installed-at")).toBe(first);
  expect(service).toHaveBeenCalledWith(
    "sweeper",
    expect.objectContaining({ start: expect.any(Function) }),
  );
  expect(register).toHaveBeenCalled();
});
