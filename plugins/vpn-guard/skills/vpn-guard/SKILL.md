---
name: vpn-guard
summary: Inspect and manage selected-machine VPN Guard admission.
---

Use `bb vpn-guard status --json` to inspect mode, selected machines, VPN decisions,
and recorded actions. `bb vpn-guard hosts <host-id>...` selects machines before
`bb vpn-guard enforce`; `bb vpn-guard observe` returns to observation. The
optional `global-suspend on --ack-global` disables Codex and Claude native
plugins across every BB machine during a selected-host block. Disabled plugins
need explicit review and `restore-owned`; redundant manual disables cannot be
distinguished. Read `docs/operations.md` before enabling.
