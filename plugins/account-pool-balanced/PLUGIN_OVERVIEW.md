Choose which provider accounts handle BB requests, set priorities and usage caps, and review the quota information each provider exposes.

## Providers

Manage Claude, Codex, Gemini through Antigravity, Grok, Kimi, OpenCode Go, Z.AI, Cursor, Devin Local CLI, and NeuralDeep. Select primary and reserve accounts, choose sequential or balanced routing, and inspect usage and reset data where providers make it available. The Pool does not increase provider limits.

## Grok

Sign in to a Grok subscription with the official `grok` CLI device flow, or add an xAI API key separately. Subscription credentials are stored by the Pool on its server. Grok ACP sessions use a scoped Pool token; Grok quota telemetry is not currently shown in the shared Usage panel.

## Requirements

Requires BB 0.46.1 or later and provider accounts you are authorized to use. Grok subscription sign-in also requires the official Grok CLI. Provider subscriptions and API usage may be billed separately; availability and limits remain controlled by each provider.

## Use it

Add and manage accounts in Account Pool settings or with `bb pool account add`; inspect routing with `bb pool status` and `bb pool --help`. Use `bb pool account add --provider grok --login` for Grok device sign-in, or `--api-key-stdin` for an xAI API key. Do not enable the built-in Account Pooler at the same time: both plugins provide the `bb pool` command.
