# VPN Guard

A BB 0.46+ plugin for host-local VPN observation and selected-machine admission control. It starts in observation mode with no machines selected. Enforcement holds ordinary protected dispatches and stops protected running turns on selected machines with bad or unknown VPN state. Kimi and Z.ai remain available.

An optional, separately acknowledged global suspension disables the Codex and Claude native plugins during a selected-machine block. Network denial for active bridges and in-flight requests is not established. See [operations and limits](docs/operations.md) for controls, ownership recovery, isolated evidence and boundaries. Built from the public BB Plugin SDK. VPN state reading follows the Account Pool Balanced policy in this repository (MIT).
