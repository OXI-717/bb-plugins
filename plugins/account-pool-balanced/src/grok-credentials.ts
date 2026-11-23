import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const sessionSchema = z
  .object({
    key: z.string().min(1),
    email: z.string().email().nullable().optional(),
    refresh_token: z.string().min(1),
    expires_at: z.union([z.string().min(1), z.number()]).optional(),
    oidc_issuer: z.string().url().optional(),
    oidc_client_id: z.string().min(1).max(256),
  })
  .passthrough();

const fileSchema = z.record(z.string(), z.unknown());

export interface GrokSubscriptionCredentials {
  label: string;
  email: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  clientId: string;
  issuer: string;
}

function expiresAt(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed < 10_000_000_000 ? Math.round(parsed * 1_000) : Math.round(parsed);
}

export function parseGrokAuthFile(raw: string): GrokSubscriptionCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Grok login file is not valid JSON.");
  }
  const file = fileSchema.safeParse(parsed);
  if (!file.success) throw new Error("Grok login file has no account entry.");
  for (const [id, value] of Object.entries(file.data)) {
    const session = sessionSchema.safeParse(value);
    if (!session.success) continue;
    const email = session.data.email ?? null;
    return {
      label: email ?? "Grok account",
      email,
      accessToken: session.data.key,
      refreshToken: session.data.refresh_token,
      expiresAt: expiresAt(session.data.expires_at),
      clientId: session.data.oidc_client_id,
      issuer: session.data.oidc_issuer ?? issuerFromEntry(id),
    };
  }
  throw new Error(
    "Grok login has no refresh token to move. Run `grok login` on the bb server host, then retry.",
  );
}

function issuerFromEntry(id: string): string {
  const issuer = id.split("::")[0] ?? "";
  return URL.canParse(issuer) ? issuer : "https://auth.x.ai";
}

export function grokAuthFilePath(): string {
  return process.env.GROK_AUTH_PATH?.trim() || path.join(os.homedir(), ".grok", "auth.json");
}

export async function importGrokCredentials(
  file = grokAuthFilePath(),
): Promise<GrokSubscriptionCredentials> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(
      "Grok login was not found. Run `grok login` on the bb server host, then retry.",
    );
  }
  const imported = parseGrokAuthFile(raw);
  const parsed: unknown = JSON.parse(raw);
  const fileRecord = fileSchema.parse(parsed);
  for (const value of Object.values(fileRecord)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.refresh_token === imported.refreshToken) {
      delete record.refresh_token;
    }
  }
  await writeFile(file, `${JSON.stringify(fileRecord)}\n`, { mode: 0o600 });
  return imported;
}
