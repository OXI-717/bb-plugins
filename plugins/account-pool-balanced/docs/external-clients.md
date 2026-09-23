# External clients and standalone server

The pool can serve agents launched outside BB. Use the BB-hosted pool to share its existing accounts, or run the standalone server without BB. Both hosts use the same hub, adapters, quota routing and affinity code. Devin Local CLI support starts with `account-pool-balanced/v0.4.0`; standalone and Devin cloud support are experimental.

## Share a BB pool

With version 0.3.0 or later, create a separate client credential:

```sh
bb pool client add orca --output /secure/client.token
```

The output file is created on the **BB server**, exclusively with mode 0600. Transfer it privately to the client machine. It contains only a pool credential, never a provider login. The base URL is `https://YOUR_BB_SERVER/api/v1/plugins/account-pool-balanced/http`. Verify the BB server is reachable from the client; this command does not expose ports or configure TLS. External credentials survive BB host inventory pruning. Revoke with `bb pool client revoke orca`; subsequent requests are rejected immediately. Already accepted requests can finish.

Pool credentials are for trusted clients belonging to the operator. They allow use of every configured model account; this is not a tenant billing or per-client spending isolation system. Use a separate pool for untrusted tenants.

## Standalone setup

Requirements: Node 22+, npm, and a compiler toolchain if the SQLite native prebuild is unavailable. No BB installation is needed for this mode:

```sh
git clone --branch account-pool-balanced/v0.4.0 --depth 1 https://github.com/OXI-717/bb-plugins.git
cd bb-plugins/plugins/account-pool-balanced
npm ci
npm run pool -- --data-dir /secure/pool import-login --provider codex
npm run pool -- --data-dir /secure/pool import-login --provider claude
npm run pool -- --data-dir /secure/pool client-add --client orca --output /secure/client.token
npm run pool -- --data-dir /secure/pool serve --port 8787
```

`import-login` reads the operator's existing local CLI login. Repeat after logging into a different account to add more accounts. It does not start a new browser login. Refresh tokens should have one active owner: do not independently run the same imported login in multiple pools. Start with a new empty directory, never BB's data directory. Stop the standalone server before running its administration commands. The lock rejects concurrent processes; after an unclean crash, confirm no server is running before removing `standalone.lock`.

For provider keys or explicitly transferred OAuth accounts, `import-account` accepts JSON on stdin (keep the file outside Git):

```json
{
  "account": {
    "provider": "claude", "kind": "api-key", "label": "primary",
    "email": null, "subscriptionType": null, "rateLimitTier": null,
    "enabled": true, "priority": 0
  },
  "secret": { "kind": "api-key", "apiKey": "REPLACE_LOCALLY" }
}
```

Use `npm run pool -- --data-dir /secure/pool import-account < /secure/account.json`. Account metadata also accepts `"role":"reserve"` and `"cap":{"early":0.5,"late":0.95}`; default is primary with no cap. `accounts` lists metadata only. `client-revoke --client orca` removes a client's token. `--config /secure/config.json` accepts the existing pool settings, for example `{"routingStrategy":"balanced","switchThreshold":0.98,"reserveDrainHours":24,"restDays":[0,6]}`. Balance and reserve behavior match BB; quota visibility still depends on the provider.

The listener defaults to `127.0.0.1`. For remote access, place it behind a TLS reverse proxy or a private tunnel. Do not expose plain HTTP on a public interface. Requests have a 16 MiB body cap; streaming responses propagate without buffering. The standalone process has no administration HTTP endpoints.

Standalone model paths:

| Provider | Path |
| --- | --- |
| Claude | `POST /v1/messages`, `/v1/messages/count_tokens` |
| Codex | `POST /v1/responses`, `/v1/responses/compact`, `/v1/images/generations`, `/v1/images/edits`, `/v1/alpha/search`; `GET /v1/models` |
| Kimi | `POST /kimi/v1/messages`, `/kimi/v1/messages/count_tokens` |
| Z.ai | `POST /zai/v1/chat/completions` |
| OpenCode Go | `POST /opencode-go/v1/chat/completions` |
| Devin Local CLI | `POST /exa.*` Connect/protobuf RPCs (via the launcher below) |

Cursor remains available through the BB host's existing custom ACP integration; standalone Cursor is not implemented. This server preserves native provider protocols, and does not translate every model into Chat Completions.

## Devin Local CLI through the pool

Add a [Devin personal access token](https://docs.devin.ai/api-reference/personal-access-tokens) to the pool on its server. This is for local `devin -p` or `devin acp`; the separate `/agents/devin/sessions` endpoints below drive Devin Cloud sessions instead.

BB-hosted pool:

```sh
bb pool account add --provider devin --api-key-stdin --label team-one
bb pool client add devin-laptop --output /secure/devin-client.token
```

Standalone pool: import an account with `"provider":"devin"`, `"kind":"api-key"` and the PAT in `secret.apiKey` using `import-account`. Create a client token with `client-add` as above. Repeat account import for each subscription; priorities and reserve roles use the ordinary pool controls. Keep PATs only on the pool server.

On the client machine, privately transfer the **client token**, install the Devin CLI and run the launcher from this plugin checkout:

```sh
node scripts/devin-pool.mjs \
  --pool-url https://YOUR_BB_SERVER/api/v1/plugins/account-pool-balanced/http \
  --token-file /secure/devin-client.token \
  -- -p 'Reply with OK' --model swe-2-high
```

For a standalone pool, use its root URL as `--pool-url`. The launcher creates an isolated, temporary Devin profile and a loopback HTTP bridge because Devin sends RPCs to absolute `/exa.*` paths, ignoring a path in `api_server_url`. It removes the temporary profile after Devin exits. The actual pool token stays in the launcher and is sent to the hub in a header; provider PATs stay on the server. To launch ACP, replace arguments after `--` with `acp` and connect its stdio to the ACP host. Add `--respect-workspace-trust false` after `-p` only when running in an intentionally trusted directory that Devin has not recorded yet.

The local CLI and ACP paths were verified with a single PAT and SWE-2 high. Multiple Devin accounts participate in the shared pool's sequential routing and HTTP quota failover; cross-account failover during an existing Devin conversation still needs a live two-PAT test because the CLI can cache an account-specific JWT. Start a fresh CLI session when switching subscriptions until that scenario is verified. Devin currently exposes no quota telemetry to this adapter, so the pool advances on upstream quota rejection rather than a displayed percentage.

## Orca and other CLI hosts

Orca launches ordinary CLI agents. Run the following in an Orca terminal, or put the invocation in your own agent launch command. These settings affect that process only; they do not modify Orca settings or global CLI configuration.

Claude Code, in a POSIX shell:

```sh
POOL_TOKEN_FILE=/secure/client.token
POOL_URL=http://127.0.0.1:8787
(
  unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
  export ANTHROPIC_BASE_URL="$POOL_URL"
  ANTHROPIC_AUTH_TOKEN=$(cat "$POOL_TOKEN_FILE")
  export ANTHROPIC_AUTH_TOKEN
  exec claude --model 'claude-opus-5-5[1m]'
)
```

Codex, using its documented custom provider configuration:

```sh
POOL_TOKEN_FILE=/secure/client.token
POOL_URL=http://127.0.0.1:8787
POOL_CLIENT_TOKEN="$(cat "$POOL_TOKEN_FILE")" codex \
  -c 'model_provider="account-pool"' \
  -c 'model_providers.account-pool.name="Account Pool"' \
  -c "model_providers.account-pool.base_url=\"$POOL_URL/v1\"" \
  -c 'model_providers.account-pool.wire_api="responses"' \
  -c 'model_providers.account-pool.requires_openai_auth=false' \
  -c 'model_providers.account-pool.env_key="POOL_CLIENT_TOKEN"' \
  -c 'model_providers.account-pool.supports_websockets=false'
```

For a BB-hosted pool, set `POOL_URL` to its plugin HTTP base URL above. Do not enable shell tracing around token loading. The token is in the child environment, not in CLI arguments. These commands connect the CLI inside Orca; they do not add a new native Orca provider UI. Configuration contract: [Codex reference](https://developers.openai.com/codex/config-reference).

## Verify routing and context

In Claude, `/status` must show your pool URL and `ANTHROPIC_AUTH_TOKEN`. The saved local login email and “API Usage Billing” label do not identify the upstream account selected by the pool. Use `bb pool status` or the BB pool panel for per-account quotas; native client screens do not show aggregate pool balances.

For Opus 5.5 use Claude Code 2.1.280 or later. Inside the session select `/model claude-opus-5-5[1m]`, then check `/context` shows a 1M denominator. Plain `opus` through a gateway was observed to budget only 200K, causing repeated compaction with large rules/MCP context. Keep automatic compaction enabled. See [Claude model configuration](https://code.claude.com/docs/en/model-config#extended-context).

In Codex, check that the provider is `Account Pool`. Choose a model available to your accounts. Unsupported models should produce a provider error, not bypass the pool. Revoking a dedicated client token should make new requests fail rather than use the local login.

BB client commands run on the server: a remote `--output` path is not a file on your laptop. Keep the server running. On the same host use `http://127.0.0.1:38886/api/v1/plugins/account-pool-balanced/http`; standalone examples use port 8787. Claude subscription connectors may be unavailable under proxy authentication.

## Devin cloud sessions (standalone host)

Devin uses a separate session API, not Messages/Responses. Import each organization credential with `import-devin` on stdin:

```json
{"id":"team-one","organizationId":"YOUR_ORG_ID","apiKey":"REPLACE_LOCALLY","maxAcuLimit":5}
```

`maxAcuLimit` caps **each session**, not total organization spend. Authentication is a Devin v3 service-user credential or supported personal access token. A browser subscription cookie is not an API credential. See [API overview](https://docs.devin.ai/api-reference/overview).

Send the pool client token as `Authorization: Bearer ...`:

| Method | Path | Body |
| --- | --- | --- |
| POST | `/agents/devin/sessions` | `{"prompt":"Investigate the failing test","account":"team-one","max_acu_limit":3}` |
| GET | `/agents/devin/sessions/SESSION_ID` | none |
| POST | `/agents/devin/sessions/SESSION_ID/messages` | `{"message":"Please run the focused tests"}` |
| DELETE | `/agents/devin/sessions/SESSION_ID` | none |

Omit `account` to distribute new sessions round-robin. Specify it when organizations have different repository access. Status includes Devin's consumed ACUs and result fields. Sessions stay on their original account across server restarts, and are visible through the pool only to the client that created them. There is no remaining-credit balancing yet. No creation is automatically retried or transferred on errors: a timeout may mean Devin already started work. Inspect Devin before retrying to avoid duplicate paid sessions. Local Devin CLI subscription proxying and a BB-native Devin conversation UI are not implemented by this adapter.

Contracts: [create](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions), [get](https://docs.devin.ai/api-reference/v3/sessions/get-organizations-session), [message](https://docs.devin.ai/api-reference/v3/sessions/post-organizations-sessions-messages), [terminate](https://docs.devin.ai/api-reference/v3/sessions/delete-organizations-sessions).

## Validation boundary

Tests cover loopback HTTP forwarding and streaming, durable standalone accounts/tokens, BB client issuance and revocation, Devin session binding, client isolation, ACU limits and non-retry behavior with synthetic upstreams. Real Claude and Codex generation from Orca terminals has been verified against the BB-hosted pool using an existing machine token. Opus 5.5 with `[1m]` accepted a synthetic request exceeding 500K input tokens. Dedicated external-client issuance/revocation and standalone forwarding use synthetic upstreams in integration tests. Real Devin execution and forced live quota exhaustion/failover have not been tested. Automated tests do not import production accounts or reload a live pool.
