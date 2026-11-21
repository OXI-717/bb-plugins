# Grok API-key provider Implementation Plan

> **For agentic workers:** Execution is a Crew queue item (one task at a time,
> footer with base/head SHAs and the focused proof). Steps use checkbox
> (`- [ ]`) syntax for tracking.

**Goal:** Accept Grok API keys in Account Pool Balanced and route `acp-grok` Chat Completions through the hub.

**Architecture:** Add `grok` to the provider enum and status maps, register it with `createOpenAiCompatibleAdapter` and `collectUsage: false`, and inject `XAI_API_KEY` plus `GROK_XAI_API_BASE_URL` only while a usable account exists. The balancer is untouched.

**Tech Stack:** TypeScript, Zod, Vitest, BB plugin SDK `experimental_contributeEnv`. Tests run with `pesado` from `plugins/account-pool-balanced`.

**Spec:** `docs/superpowers/specs/2026-11-04-grok-api-key-provider.md`

## Global Constraints

- Provider id `grok`. BB provider id `acp-grok`. Upstream default `https://api.x.ai/v1`. Config key `grokUpstreamBaseUrl`. Mount prefix `grok/`.
- Env names: `XAI_API_KEY` (hub token), `GROK_XAI_API_BASE_URL` (hub path ending in `/grok/v1`).
- API key via `--api-key-stdin` only. `--login` stays limited to `claude` and `codex`.
- No new dependency. No migration. No balancer edit. Package version stays `0.4.32`. No tag, publish, or live hub reload.
- Fixtures are synthetic. The real key never appears in env, logs, git, or the upstream URL.
- `grok` is not added to `vpnOnlyProviders`. Guard exemptions stay `kimi` and `zai` only.
- Do not claim `acp-grok` sessions are pooled until the manual check in the spec sees `POST /grok/v1/chat/completions`.

## File structure

- `plugins/account-pool-balanced/src/contracts.ts` — provider enum, upstream URL, status `activeAccounts` and `routing`.
- `plugins/account-pool-balanced/src/hub.ts` — status `activeAccounts.grok` and the adapter map entry.
- `plugins/account-pool-balanced/src/operations.ts` — status `routing.grok`.
- `plugins/account-pool-balanced/src/openai-compatible-adapter.ts` — `GROK_MOUNT_PREFIX` and `collectUsage`.
- `plugins/account-pool-balanced/src/server.ts` — route table entry, `retryProviders`, thread provider map.
- `plugins/account-pool-balanced/src/cli.ts`, `app.tsx`, `src/usage-source.ts`, `src/browser-profiles.ts`, `src/standalone/http.ts` — help text, card, usage id, browser title, standalone path.
- Docs: `PLUGIN_OVERVIEW.md`, `docs/external-clients.md`, `skills/account-pool/references/accounts-and-routing.md`.
- Tests live next to those files. No new production file.

## Review Focus

- An empty or disabled Grok pool must leave `acp-grok` env unchanged, so a working `grok login` is not replaced by a hub token. Task 3.
- The upstream `Authorization` must be the stored API key, never the hub token from the inbound request. Task 3.
- The upstream URL must be `{base}/chat/completions`, with a single `/v1` taken from the base. Task 2.
- `refreshUsage` must not call the network for Grok. Task 2.
- With the guard enabled, `grok` is blocked with Kimi and Z.ai still exempt. Task 3.

---

### Task 1: Provider identity

**Files:**
- Modify: `plugins/account-pool-balanced/src/contracts.ts` (`providerSchema`, `DEFAULT_ACCOUNT_POOL_CONFIG`, both config schemas, `statusSchema.activeAccounts`, `statusSchema.routing`)
- Modify: `plugins/account-pool-balanced/src/hub.ts` (the `activeAccounts` object near the `activeFor` helper)
- Modify: `plugins/account-pool-balanced/src/operations.ts` (`status()`, the `Promise.all` list and the `routing` object)
- Test: `plugins/account-pool-balanced/src/grok-contract.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `PoolProvider` includes `"grok"`. `AccountPoolConfig.grokUpstreamBaseUrl: string`, default `https://api.x.ai/v1`. `PoolStatus.activeAccounts.grok` and `PoolStatus.routing.grok`.

- [ ] **Step 1: Write the failing test**

`grok-contract.test.ts` asserts `providerSchema.parse("grok")` is `"grok"` and `accountPoolConfigSchema.parse({}).grokUpstreamBaseUrl` is `https://api.x.ai/v1`. It parses this status and expects `activeAccounts.grok` to be `null`:

```ts
const status = {
  route: "/http",
  enabledAccountCount: 0,
  inFlight: 0,
  accepting: true,
  hosts: [],
  accounts: [],
  activeAccounts: {
    claude: null, codex: null, kimi: null, zai: null,
    "opencode-go": null, cursor: null, devin: null, grok: null,
  },
  routing: {
    claude: true, codex: true, kimi: true, zai: true,
    "opencode-go": true, cursor: true, devin: true, grok: true,
  },
};
```

`statusSchema.safeParse` of that object with `grok` removed from `activeAccounts` has `success` false.

- [ ] **Step 2: Run the test**

Run: `pesado npx vitest run src/grok-contract.test.ts`
Expected: FAIL, `"grok"` rejected by the enum.

- [ ] **Step 3: Add the identity**

Add `"grok"` to `providerSchema`. Add `grokUpstreamBaseUrl` beside the other upstream URLs in the default, `accountPoolConfigSchema`, and `accountPoolConfigSetInputSchema`. Add `grok` to both strict objects in `statusSchema`, to `hub.status().activeAccounts`, and to `operations.status()` routing. Do not add `grok` to the `vpnOnlyProviders` enum.

- [ ] **Step 4: Run the test**

Run: `pesado npx vitest run src/grok-contract.test.ts`
Expected: PASS, 1 file.

- [ ] **Step 5: Commit**

```bash
git add plugins/account-pool-balanced/src/contracts.ts plugins/account-pool-balanced/src/hub.ts plugins/account-pool-balanced/src/operations.ts plugins/account-pool-balanced/src/grok-contract.test.ts
git commit -m "feat: add the grok pool provider id"
```

### Task 2: OpenAI-compatible adapter

**Files:**
- Modify: `plugins/account-pool-balanced/src/openai-compatible-adapter.ts`
- Modify: `plugins/account-pool-balanced/src/hub.ts` (adapter `Map` next to the `zai` entry)
- Test: `plugins/account-pool-balanced/src/openai-compatible-adapter.test.ts`

**Interfaces:**
- Consumes: `PoolProvider` `"grok"`, `AccountPoolConfig.grokUpstreamBaseUrl`
- Produces: `GROK_MOUNT_PREFIX = "grok/"`. `OpenAiCompatibleAdapterOptions.collectUsage?: boolean` (default `true`). When `false`, `refreshUsage` returns without calling `fetch`. Hub adapter: `provider: "grok"`, `upstreamName: "xAI"`, `mountPrefix: GROK_MOUNT_PREFIX`, `upstreamBaseUrl: (settings) => settings.grokUpstreamBaseUrl`, `usagesUrl: "https://api.x.ai/v1/models"`, `collectUsage: false`, `parseUsages: () => null`.

- [ ] **Step 1: Write the failing test**

In `openai-compatible-adapter.test.ts`, build the adapter with `collectUsage: false`, a `fetch` that throws if called, and a `freshSecret` that throws if called. `refreshUsage` resolves, and neither was called. `upstreamUrl` for a request path ending in `/grok/v1/chat/completions` and base `https://api.x.ai/v1` equals `https://api.x.ai/v1/chat/completions`. `requestHeaders` sets `authorization` to `Bearer sk-stored` from an `{ kind: "api-key", apiKey: "sk-stored" }` secret and does not keep an inbound `Authorization: Bearer hub-token`. `importAccount()` rejects with a message that contains `--api-key-stdin`.

- [ ] **Step 2: Run the test**

Run: `pesado npx vitest run src/openai-compatible-adapter.test.ts`
Expected: FAIL, `GROK_MOUNT_PREFIX` or `collectUsage` missing.

- [ ] **Step 3: Implement the option and register the adapter**

Add `collectUsage?: boolean` to `OpenAiCompatibleAdapterOptions`. In `refreshUsage`, return immediately when it is `false`, before `freshSecret`. Export `GROK_MOUNT_PREFIX`. Register the hub entry with the values in Interfaces. `parseUsages` is `() => null`.

- [ ] **Step 4: Run the test**

Run: `pesado npx vitest run src/openai-compatible-adapter.test.ts`
Expected: PASS, including the existing OpenCode Go cases.

- [ ] **Step 5: Commit**

```bash
git add plugins/account-pool-balanced/src/openai-compatible-adapter.ts plugins/account-pool-balanced/src/openai-compatible-adapter.test.ts plugins/account-pool-balanced/src/hub.ts
git commit -m "feat: route grok through the OpenAI-compatible adapter"
```

### Task 3: Hub route, env injection, guard

**Files:**
- Modify: `plugins/account-pool-balanced/src/server.ts` (`openAiCompatibleRoutes`, `retryProviders`, the thread `providerId` map)
- Modify: `plugins/account-pool-balanced/src/server.test.ts` (`createFixture` base URLs and the key branch)
- Modify: `plugins/account-pool-balanced/src/guard-network.test.ts`
- Modify: `plugins/account-pool-balanced/src/vpn-policy.test.ts`
- Test: those three test files

**Interfaces:**
- Consumes: `GROK_MOUNT_PREFIX`, the hub adapter from Task 2
- Produces: route entry `{ provider: "grok", mountPrefix: GROK_MOUNT_PREFIX, providerId: "acp-grok", keyEnv: "XAI_API_KEY", baseUrlEnv: "GROK_XAI_API_BASE_URL" }`. `retryProviders["acp-grok"] = "grok"`. The thread map sends `acp-grok` to `"grok"`. The existing loop already mounts `chat/completions`, `responses`, and `models`.

- [ ] **Step 1: Write the failing tests**

1. `createFixture({ provider: "grok", upstreamUrl: "https://upstream.example" })` resolves `XAI_API_KEY` to the hub token and `GROK_XAI_API_BASE_URL` to a path ending in `/grok/v1`, via `resolveAcpEnv(host, "acp-grok", "XAI_API_KEY", "GROK_XAI_API_BASE_URL")`. Set `grokUpstreamBaseUrl` from `args.upstreamUrl` in that helper.
2. `POST /grok/v1/chat/completions` with `Authorization: Bearer <hub token>` and body `{"model":"fixture","messages":[{"role":"user","content":"test"}]}` calls upstream once. The outbound URL is `https://upstream.example/chat/completions`. The outbound `authorization` is `Bearer sk-account`, not the hub token.
3. On a fixture whose only account is Claude, `resolveProviderEnv("acp-grok", { threadId: "thread-acp-grok", projectId: "project-one", hostId: "host-one" })` equals `[]`.
4. In `guard-network.test.ts`, add `"grok"` to the blocked list of "gates OpenCode Go as well as Devin, leaving only Kimi and Z.ai exempt". Change the expected `read` count from 5 to 6. `requiresGuardCheck("grok")` is `true`.
5. In `vpn-policy.test.ts`, add `"grok"` to the independent list beside `opencode-go`. The reader stays uncalled for that list. The protected list stays `codex`, `claude`, `cursor`, `devin`.

- [ ] **Step 2: Run the tests**

Run: `pesado npx vitest run src/server.test.ts src/guard-network.test.ts src/vpn-policy.test.ts`
Expected: FAIL on the new grok assertions. Existing files are large; if the run is too noisy, run the new `it` names first, then the two policy files.

- [ ] **Step 3: Wire the route**

Add the route entry, `retryProviders["acp-grok"]`, and the thread-map entry. Extend `createFixture` so a `grok` provider resolves the two env names. Do not change `requiresGuardCheck` or `requiresIpv4`: `grok` is already outside the Kimi/Z.ai exemption.

- [ ] **Step 4: Run the tests**

Run: `pesado npx vitest run src/server.test.ts src/guard-network.test.ts src/vpn-policy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/account-pool-balanced/src/server.ts plugins/account-pool-balanced/src/server.test.ts plugins/account-pool-balanced/src/guard-network.test.ts plugins/account-pool-balanced/src/vpn-policy.test.ts
git commit -m "feat: inject the grok hub route into acp-grok"
```

### Task 4: CLI, UI, usage id, docs

**Files:**
- Modify: `plugins/account-pool-balanced/src/cli.ts` (the four help lines that list providers)
- Modify: `plugins/account-pool-balanced/app.tsx` (`PROVIDERS`)
- Modify: `plugins/account-pool-balanced/app.test.tsx` (status fixtures that list every provider)
- Modify: `plugins/account-pool-balanced/src/usage-source.ts` (`USAGE_PROVIDER_IDS`, `USAGE_FALLBACK_LABELS`)
- Modify: `plugins/account-pool-balanced/src/usage-source.test.ts`
- Modify: `plugins/account-pool-balanced/src/browser-profiles.ts` (`PROVIDER_TITLE`)
- Modify: `plugins/account-pool-balanced/src/standalone/http.ts` (the `routes` map)
- Modify: `plugins/account-pool-balanced/PLUGIN_OVERVIEW.md`, `plugins/account-pool-balanced/docs/external-clients.md`, `plugins/account-pool-balanced/skills/account-pool/references/accounts-and-routing.md`
- Test: `src/cli` coverage inside `src/server.test.ts`, `app.test.tsx`, `src/usage-source.test.ts`

**Interfaces:**
- Consumes: provider `"grok"` from Task 1
- Produces: help text `bb pool account add --provider <kimi|zai|opencode-go|cursor|devin|grok> --api-key-stdin`. Card title `Grok`, description `acp-grok threads use these keys; only the hub token remains on the machine.` `USAGE_PROVIDER_IDS.grok = "acp-grok"`. `USAGE_FALLBACK_LABELS.grok = "Grok"`. `PROVIDER_TITLE.grok = "Grok"`. Standalone route `["/grok/v1/chat/completions", "grok"]`. `--login` with `--provider grok` still throws `--login requires --provider claude or --provider codex.`

- [ ] **Step 1: Write the failing tests**

`bb pool --help` stdout contains `grok` in the api-key-stdin provider list. A CLI invocation `account add --provider grok --login` exits non-zero with that `--login` error. `USAGE_PROVIDER_IDS.grok` is `acp-grok`. Each `app.test.tsx` status fixture that names every provider also has `grok: null` or `grok: true` in the same shape as `devin`.

- [ ] **Step 2: Run the tests**

Run: `pesado npx vitest run src/usage-source.test.ts app.test.tsx src/server.test.ts`
Expected: FAIL, missing `grok` key or help text.

- [ ] **Step 3: Update the surfaces**

Add the help token, the card, the two usage maps, the browser title, the standalone path, and one row in the external-clients table: `POST /grok/v1/chat/completions`. Mention Grok in the supported-adapters sentence of `PLUGIN_OVERVIEW.md`. Add `grok` to the provider lists in the skill reference. Do not document device login.

- [ ] **Step 4: Run typecheck, the focused tests, and the build**

Run: `pesado npx vitest run src/grok-contract.test.ts src/openai-compatible-adapter.test.ts src/usage-source.test.ts src/guard-network.test.ts src/vpn-policy.test.ts app.test.tsx src/server.test.ts`
Expected: PASS. Count the files: 7.

Run: `pesado npx tsc --noEmit`
Expected: exit 0.

Run: `pesado npm run build`
Expected: exit 0. Do not reload the live plugin.

- [ ] **Step 5: Commit**

```bash
git add plugins/account-pool-balanced/src/cli.ts plugins/account-pool-balanced/app.tsx plugins/account-pool-balanced/app.test.tsx plugins/account-pool-balanced/src/usage-source.ts plugins/account-pool-balanced/src/usage-source.test.ts plugins/account-pool-balanced/src/browser-profiles.ts plugins/account-pool-balanced/src/standalone/http.ts plugins/account-pool-balanced/PLUGIN_OVERVIEW.md plugins/account-pool-balanced/docs/external-clients.md plugins/account-pool-balanced/skills/account-pool/references/accounts-and-routing.md
git commit -m "feat: show grok in the pool CLI and settings"
```

## Manual check

Not a code task. After the branch exists, one `acp-grok` thread with a synthetic key in the pool must produce `POST /grok/v1/chat/completions` on the hub. If the CLI talks to `GROK_CODE_BACKEND_URL` instead, record that and stop. The follow-up is a separate plan.
