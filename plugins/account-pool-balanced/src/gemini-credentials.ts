import { chmod, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GEMINI_OAUTH_CLIENT_ID } from "./gemini-oauth.js";

export interface GeminiSubscriptionCredentials {
  label: string;
  email: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  clientId: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function emailOf(value: unknown): string | null {
  const email = text(value);
  return email !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null;
}

export function parseGeminiExpiry(value: unknown, expiresIn: unknown, now: number): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? Math.round(value * 1_000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const normalized = value.trim().replace(/(\.\d{3})\d+(Z|[+-]\d{2}:?\d{2})$/u, "$1$2");
    const parsed = Date.parse(normalized);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0) {
    return now + Math.round(expiresIn * 1_000);
  }
  return null;
}

export function parseGeminiAuthFile(raw: string, now = Date.now()): GeminiSubscriptionCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Gemini login file is not valid JSON.");
  }
  const root = record(parsed);
  const nested = record(root?.token);
  const accessToken = text(nested?.access_token) ?? text(root?.access_token);
  const refreshToken = text(nested?.refresh_token) ?? text(root?.refresh_token);
  if (root === null || accessToken === null || refreshToken === null) {
    throw new Error(
      "Gemini login has no refresh token to move. Run `agy acp --login` on the bb server host, then retry.",
    );
  }
  const email = emailOf(root.id_token_email) ?? emailOf(root.email);
  return {
    label: email ?? "Gemini account",
    email,
    accessToken,
    refreshToken,
    expiresAt: parseGeminiExpiry(
      nested?.expiry ?? root.expiry,
      nested?.expires_in ?? root.expires_in,
      now,
    ),
    clientId: GEMINI_OAUTH_CLIENT_ID,
  };
}

export function geminiAuthFilePath(geminiDir = process.env.ANTIGRAVITY_GEMINI_DIR?.trim() || path.join(os.homedir(), ".gemini")): string {
  return path.join(geminiDir, "antigravity-cli", "antigravity-oauth-token");
}

export async function importGeminiCredentials(
  file = geminiAuthFilePath(),
  now = Date.now(),
): Promise<GeminiSubscriptionCredentials> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      "Gemini login was not found. Run `agy acp --login` on the bb server host, then retry.",
    );
  }
  const imported = parseGeminiAuthFile(raw, now);
  const root = record(JSON.parse(raw));
  if (root === null) {
    throw new Error("Gemini login file is not valid JSON.");
  }
  const nested = record(root.token);
  if (nested !== null) delete nested.refresh_token;
  delete root.refresh_token;
  await writeFile(file, `${JSON.stringify(root)}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return imported;
}
