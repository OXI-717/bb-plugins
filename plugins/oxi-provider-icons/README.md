# OXI Provider Icons

Presentation-only BB plugin: one registry of local, theme-aware SVG marks for
seven public-safe OXI agent provider ids. Every surface BB draws through its
shared provider icon resolver — the model picker rows and the builtin
provider usage header — picks the marks up through the experimental
`app.slots.experimental_providerIcon` slot.

## Registered providers

| Provider id | Mark |
|---|---|
| `acp-agy` | Antigravity mark (upstream BB asset) |
| `acp-opencode-kimi` | Kimi mark (upstream BB asset) |
| `acp-oxi-cursor` | Cursor mark with a two-dot pool badge |
| `acp-oxi-devin-pool` | Devin mark with a two-dot pool badge |
| `acp-opencode-go` | OpenCode mark with a chevron go badge |
| `acp-opencode-zai` | Original neutral "Z" monogram, not an official logo |
| `acp-opencode-neuraldeep` | Original neutral "ND" monogram, not an official logo |

Every mark is an inline SVG painted with `currentColor`, sized by the host's
`className` (legible at 14 and 16 px), with no scripts, external references,
network access, timers or storage.

## Fallback and disable behavior

The plugin deliberately does not claim the built-in providers (`codex`,
`claude-code`, `acp-cursor`), Grok or unknown ids: they keep the host's own
artwork. Disabling the plugin, and every surface rendered before the frontend
bundle has loaded, falls back to the host glyphs everywhere. The host keeps
the first registration per provider kind and id and warns on conflicts, so
no other plugin needs to change.

## Backend and settings

There is nothing to configure: the backend entry is intentionally empty and
the plugin declares no settings, storage, RPC, network or schedules.

## Licensing

Five marks reuse upstream BB (`get-bb/bb`, MIT License, Copyright (c) 2026
Michael Yong) `provider-acp` registry icon geometry: the Antigravity, Kimi,
Cursor, Devin and OpenCode paths. The pool and go badges, and the Z.ai and
NeuralDeep monograms, are local original geometry. The upstream MIT notice is
preserved in [LICENSE](./LICENSE); provenance details are in the repository's
[THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Development

From this directory:

```bash
npm ci
npm run typecheck
npm test
npm run build          # bb plugin build .
npm run preview:build  # synthetic preview into preview/dist (git-ignored)
```

Serve `preview/dist/` with any static file server on a free localhost port.
The preview renders the real registration and the real mark components
against a shim SDK with synthetic picker and usage chrome; query parameters:
`theme=light|dark`, `pane=390|768` (default desktop).

Requires BB 0.50.1+ and Plugin SDK 0.6.157.
