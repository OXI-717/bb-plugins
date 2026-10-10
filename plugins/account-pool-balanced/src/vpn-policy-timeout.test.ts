import { afterEach, expect, it, vi } from "vitest";
import { open, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { readVpnState } from "./vpn-policy.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.mocked(open).mockClear(); });

it("bounds stalled opens and reuses the denied result until the I/O settles", async () => {
  vi.useFakeTimers();
  vi.mocked(open).mockImplementation(() => new Promise(() => {}));
  const requests = Array.from({ length: 5 }, () => readVpnState("/synthetic/stalled-vpn-open.json", 1_800_000_000_000));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await Promise.all(requests)).toEqual(Array(5).fill("unknown"));
  expect(await readVpnState("/synthetic/stalled-vpn-open.json", 1_800_000_001_000)).toBe("unknown");
  expect(open).toHaveBeenCalledOnce();
});

it("includes delayed handle cleanup in the deadline", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const directory = await mkdtemp(path.join(tmpdir(), "vpn-cleanup-"));
  const file = path.join(directory, "state.json");
  await writeFile(file, "{}");
  const handle = await actual.open(file, "r");
  const close = handle.close.bind(handle);
  let release = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  const delayedClose = vi.spyOn(handle, "close").mockImplementation(async () => { await pending; await close(); });
  vi.mocked(open).mockResolvedValue(handle);
  try {
    vi.useFakeTimers();
    const result = readVpnState(file, 1_800_000_000_000);
    await vi.waitFor(() => expect(delayedClose).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe("unknown");
    expect(await readVpnState(file, 1_800_000_001_000)).toBe("unknown");
    expect(open).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
    release();
    await pending;
    await rm(directory, { recursive: true, force: true });
  }
});
