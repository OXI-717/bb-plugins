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

const authFileSchema = z.record(z.string(), z.unknown());

export interface GrokSubscriptionCredentials {
  label: string;
  email: string | null;
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  clientId: string;
}

function parseExpiry(value: string | number | undefined): number | null {
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
    throw new Error("Grok login returned an invalid credentials file.");
  }
  const file = authFileSchema.safeParse(parsed);
  if (!file.success) throw new Error("Grok login returned no account credentials.");

  for (const value of Object.values(file.data)) {
    const session = sessionSchema.safeParse(value);
    if (!session.success) continue;
    const email = session.data.email ?? null;
    return {
      label: email ?? "Grok account",
      email,
      accessToken: session.data.key,
      refreshToken: session.data.refresh_token,
      expiresAt: parseExpiry(session.data.expires_at),
      clientId: session.data.oidc_client_id,
    };
  }
  throw new Error("Grok login returned no refreshable OAuth account.");
}
