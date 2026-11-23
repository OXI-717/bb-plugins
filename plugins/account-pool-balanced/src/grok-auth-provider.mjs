const token = process.env.BB_POOL_GROK_HUB_TOKEN ?? "";
if (token.length === 0) process.exit(1);
const expiresIn = Number(process.env.GROK_AUTH_TOKEN_TTL ?? 3600);
process.stdout.write(JSON.stringify({
  access_token: token,
  expires_in: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600,
}));
