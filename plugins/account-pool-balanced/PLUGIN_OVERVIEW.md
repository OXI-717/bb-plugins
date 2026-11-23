## Features

The pool selects an account for each request and shows quota usage and reset times (UTC+3). Account cards also show successful requests through the pool since version 0.4.2 was installed; this is not the provider's remaining quota. Available strategies include sequential and balanced, with primary and reserve accounts and per-account usage caps. Supported adapters: Claude, Codex, Kimi, Z.AI, OpenCode Go, Cursor, Devin Local CLI, Grok, and Gemini. Devin does not yet provide numeric quota telemetry, so it is omitted from the shared Usage panel. Each CLI run is pinned to one PAT; switching happens on a new run after the account reaches a limit. Grok and Gemini sign-in and import use the subscription. An API key is only the paid fallback, used when no subscription account is enabled. Both report quota in the shared Usage panel.

## Local setup

Add accounts in the installed BB. Secrets, account order, thresholds, and routing remain on the user's server and are not sent to the marketplace. A new user starts with an empty pool. A thread can bypass the pool and use its own authentication.

## Requirements

BB 0.46.1 or later, Node/npm for installation from Git, and provider accounts you are authorized to use. Subscriptions and APIs are billed separately; the plugin does not increase account limits. Model availability is determined by the provider.

## Commands

Settings are available in the UI and through `bb pool --help`. See [External clients](docs/external-clients.md) for Devin CLI and other clients. Check status with `bb pool status`; update with `bb plugin update account-pool-balanced`. Do not enable the built-in Account Pooler at the same time; both plugins use the `bb pool` command.

`bb pool browser open <id|email|label> [--url <https-url>]` opens a persistent Helium account browser named `<Provider> · <email>`. Without a destination (including `about:blank`), Pooler requests Helium's native last-session restore and does not add an empty tab. New profiles without a saved session use the browser's normal startup page. An explicit HTTPS URL opens alongside the restored session. Before the first managed launch after upgrading, while Helium is fully closed, Pooler enables native last-session restore once for each managed profile (including secondary profiles opened later). It preserves other preferences, history, cookies and saved sessions. Later manual startup preference changes are respected; Helium decides which saved windows/tabs can be restored. URLs accept HTTPS without embedded credentials; command output shows only the site origin. `POOL_BROWSER_EXECUTABLE` overrides the Helium binary.

In Pooler settings, choose **Open in browser** from an account's action menu or details. A missing profile is created on first open; later opens reuse it. Details accept an optional HTTPS link, including a provider authorization link. Claude reauthorization also offers **Open in account profile** for its current authorization URL. The window opens on the Pooler server machine, not on a remote dashboard device. Browser sign-in and connecting an account to the pool remain separate; OAuth/API-key onboarding is unchanged. Authorization URLs are not saved in settings or browser-launch acknowledgements. UI navigation uses owner-only temporary local HTML documents (0700 directory, 0600 files), so the link does not appear in browser process arguments. Documents expire after five minutes or are removed when the owned browser exits; at most 32 may be outstanding. Partial writes remain owned until cleanup; failed removal retains its capacity slot and retries every minute. Abnormal supervisor termination can leave private files in the OS temporary directory. The browser runs without DevTools, automation switches, or WebDriver spoofing. Prefer the UI for one-time authorization links; an explicit CLI `--url` value is still visible in the caller's command line.

All accounts use ordinary native profiles in one Helium user-data root. The native profile menu lists them together, including when Helium is opened manually. The first managed launch registers the current account list while Helium is fully closed. A newly added account needs one closed-browser window to update the list. Each account keeps a separate profile directory, cookies and site storage. The registry remains in the BB server plugin data directory under `browser-profiles/registry.json`; `bb pool browser list [--json]` reports the binding and existence of each profile.

Upgrading from separate `Pool Accounts/Profile N` roots requires closing all Helium processes once. Migration copies the active isolated profile to a fresh native directory, retaining both the isolated source and any older native copy. It preserves unrelated native profiles and removes an obsolete picker entry only when its name matches the old account binding. Existing registry/Local State snapshots and a resumable migration plan stay beside the registry. Copy failures do not switch the binding; completed copies are reused after a metadata-write failure. Missing/unsafe sources, occupied destinations and incompatible encryption metadata refuse migration. Do not open Helium during migration. Copies use the same application and OS storage; moving them across hosts or browser applications is unsupported. Registry operations use a kernel-owned loopback lease across CLI/RPC processes.

Managed launch requires VPN/2 verified IPv4 evidence and a valid exit timezone for **every browser profile**, including Kimi/Z.ai: native switching can reach protected accounts without calling Pooler again. This does not change the pool API providers' VPN exemptions. One detached supervisor owns the common browser's local IPv4 CONNECT proxy and process timezone. Switching profiles within that browser retains its process settings. Every managed open rechecks VPN/geo before handoff. The browser launch check is not a continuous VPN monitor or packet firewall.

Navigation to an explicit HTTPS URL uses Helium's native profile-directory launch with a private local document that redirects to the requested URL. An unguessable readiness receipt from the private document is handled locally by the proxy (no external request and no authorization URL in its response). It confirms the local document loaded before allowing another launch; it does not confirm the destination page or account sign-in. Session-only opens use ordinary native launch acceptance and create no navigation document; their acknowledgement does not attest restoration of individual tabs. Shared-profile protocol 5 rejects older supervisors before sending a URL; fully quit Helium once after upgrading and reopen from Pooler.

The supervisor survives plugin reloads and keeps the proxy alive until the owned browser exits. Shared browsers use normal native lifetime: on macOS close the application with Command-Q; closing the last window can leave Helium running in the Dock. Automatic last-window quit is intentionally not provided by attaching a debugger to the interactive browser. Changing exit timezone/executable requires closing the shared browser first. An already-running unmanaged Helium cannot be adopted: close it and start through Pooler. Direct Dock launch without a supervisor uses ordinary system networking and lifetime. macOS/Linux Unix sockets are supported.


Use the provider UI for manual login, billing and [saved resets](docs/saved-resets.md). The command does not log in, export cookies or change pool routing.


## Plugin-only network protection

After updating VPN Guard to 0.1.2 and Pooler to 0.4.14, enable `bb pool config set vpnGuardEnabled true` (the **Follow VPN Guard** checkbox). Select the pool server machine in Guard. When manually blocked or unavailable, Guard causes protected calls from the pool itself to return a temporary local 503; requests or streams already held by the pool are cancelled at the next check. Kimi and Z.AI remain independent. Without this linkage, a manual block controls only BB threads.

Enable the persisted Pooler linkage after upgrading both plugins. Guard covers Cursor/Devin Pool aliases and supplies an uncached network decision for the pool server. Missing, malformed, or timed-out Guard fails closed for protected traffic owned by the pool. No BB build or system firewall changes are needed; direct/native Send-now and independent maintenance remain outside the strict guarantee. See [implemented guarantees and limits](../../docs/vpn-plugin-protection-limits.md).

Devin quota collection is not implemented. Its accounts remain available for routing but are omitted from the shared Usage inventory; stale quota-resource requests fail explicitly without a provider call.

[Unified protection](../../docs/unified-protection.md): VPN evidence /2, an optional automation controller, independent pause reasons, and explicit recovery. Strict mode and controller integration are off by default.

An automation controller is not required for Pooler or its VPN Guard linkage and is not bundled with the public plugins. It is only needed for optional scheduler control.

[Pooler errors](../../docs/pool-errors.md): stable reason codes, provider-native responses, and distinct quota threshold/exhaustion messages. Reason codes and messages distinguish a configured threshold from an exhausted provider limit.

Automatic recovery uses ordinary BB admission and preserves manual blocks and newer user activity. See the [recovery policy](../../docs/pool-errors.md).

[Account in the thread header](docs/account-identities.md): shows the email or saved label of the subscription actually used for every provider. For API keys, enter an email in the account card; OAuth email comes from the provider.

Project-bound Codex budget clients can use the [versioned budget evidence endpoint](docs/codex-budget.md).

The native Update Pooler action pauses BB sessions and pooled model requests, verifies a state backup, installs a published release, checks settings and releases its own pause. The maintenance lease survives reloads and requests are not replayed automatically. See the [upgrade procedure](../../scripts/UPGRADE-POOL.md#update-from-the-pool-interface).
