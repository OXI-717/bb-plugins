---
name: vpn-guard
summary: Inspect and manage the VPN Guard admission mode.
---

Use `bb vpn-guard status --json` to see host-local VPN decisions and actions.
`bb vpn-guard enforce` opts in to active admission control; `bb vpn-guard observe`
returns to read-only observation. Enforcement may stop running protected turns and
set provider opt-outs. See `docs/operations.md` before enabling.
