import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const GEMINI_TOKEN_NAME = "antigravity-oauth-token";
export const GEMINI_SYNTHETIC_EXPIRY = "2099-01-01T00:00:00Z";

export function geminiPoolHomeDir(dataDir: string, hubToken: string): string {
  const hash = createHash("sha256").update(hubToken).digest("hex").slice(0, 32);
  return path.join(dataDir, "gemini-homes", hash, "home");
}

export async function writeGeminiPoolHome(input: {
  dataDir: string;
  hubToken: string;
  email: string | null;
}): Promise<string> {
  const home = geminiPoolHomeDir(input.dataDir, input.hubToken);
  const profileDir = path.dirname(home);
  const geminiDir = path.join(home, ".gemini");
  const cliDir = path.join(geminiDir, "antigravity-cli");
  await mkdir(cliDir, { recursive: true, mode: 0o700 });
  for (const directory of [profileDir, home, geminiDir, cliDir]) {
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error("Gemini Pool home path must contain only real directories");
    }
    await chmod(directory, 0o700);
  }
  const body: Record<string, unknown> = {
    token: {
      access_token: input.hubToken,
      token_type: "Bearer",
      expiry: GEMINI_SYNTHETIC_EXPIRY,
    },
    auth_method: "consumer",
  };
  if (input.email !== null) body.id_token_email = input.email;
  const file = path.join(cliDir, GEMINI_TOKEN_NAME);
  await writeFile(file, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return home;
}
