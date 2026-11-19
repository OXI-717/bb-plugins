import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { access } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import { GrokDeviceLogin } from "./grok-device-login.js";

it("terminates and removes an abandoned Grok login at expiry", async () => {
  vi.useFakeTimers();
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  let grokHome!: string;
  const spawnLogin = vi.fn((env: NodeJS.ProcessEnv) => {
    grokHome = env.GROK_HOME!;
    setTimeout(() => child.stdout.write("https://login.example code: TEST"), 1);
    return child as unknown as ReturnType<NonNullable<ConstructorParameters<typeof GrokDeviceLogin>[0]["spawnLogin"]>>;
  });
  const login = new GrokDeviceLogin({ spawnLogin, addAccount: vi.fn() });
  try {
    const starting = login.start();
    await vi.waitFor(() => expect(spawnLogin).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(25);
    const started = await starting;
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(started.expiresAt - Date.now());
    expect(child.kill).toHaveBeenCalledOnce();
    await vi.waitFor(async () => expect(access(grokHome)).rejects.toThrow());
    expect(login.cancel({sessionId: started.sessionId})).toBe(false);
  } finally {
    login.dispose();
    vi.useRealTimers();
  }
});
