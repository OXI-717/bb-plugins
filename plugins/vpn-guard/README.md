# VPN Guard

A BB 0.46+ plugin that observes host-local VPN status and, when explicitly enabled, holds protected dispatches, stops protected running turns, and records provider opt-outs. It starts in observation mode.

See [operations and limits](docs/operations.md). Use `bb vpn-guard status --json`, `bb vpn-guard enforce`, or `bb vpn-guard observe`; the VPN Guard panel exposes the same state and mode. Built from the public BB Plugin SDK. VPN state reading follows the Account Pool Balanced policy in this repository (MIT).
