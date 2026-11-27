---
name: provider-icons
description: Mark OXI agent providers with local theme-aware icons in BB's model picker and provider usage header.
---

# OXI Provider Icons

Registers inline SVG marks for exactly seven public-safe agent provider ids
(`acp-agy`, `acp-opencode-kimi`, `acp-oxi-cursor`, `acp-oxi-devin-pool`,
`acp-opencode-go`, `acp-opencode-zai`, `acp-opencode-neuraldeep`) through
the experimental `app.slots.experimental_providerIcon` slot. The host's
model picker and builtin provider usage header resolve them automatically.
Presentation-only: no backend surface, settings, storage, network or
timers.

Built-in providers (`codex`, `claude-code`, `acp-cursor`), Grok and unknown
ids are deliberately not claimed; the host artwork stays. Disabling the
plugin, or any surface rendered before the frontend bundle loads, falls
back to the host glyphs. Do not add private provider labels or account
inventories to the registry.
