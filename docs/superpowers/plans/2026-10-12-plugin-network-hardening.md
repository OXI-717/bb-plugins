# Plugin-only VPN hardening

Approved scope: no BB source/build changes and no OS firewall/hosts changes. Classify native and pool aliases consistently. Add a minimal versioned Guard network decision RPC. Pooler opt-in vpnGuardEnabled consults it on the pool server host before every protected outbound call, with no allow caching and fail-closed on missing/invalid/unresponsive Guard. Chinese providers stay independent. Track and cancel Pooler-owned requests/streams on policy denial with bounded periodic reconciliation. Show effective policy state separately from actual VPN. Existing native suspension remains explicit global opt-in and manual restore.

- [ ] Tests: aliases; Guard network decision scope/manual/Observe/Enforce/native ownership; Pooler no-upstream counters, missing/invalid Guard and provider exclusions, retries, stream cancellation and cleanup.
- [ ] Implement minimal RPC, client and config/CLI/UI surfaces; retain backwards defaults.
- [ ] Verify focused tests/types/build and actual isolated cross-plugin RPC with synthetic upstream. Document no zero-latency/packet guarantee; Send-now bypass in BB, direct/native maintenance, scripts and arbitrary CLI sockets remain outside plugin-only control.
- [ ] Independent review; publication gates; CI on exact HEAD; release both plugins; upgrade Guard without active block, then Pooler only through idle/backup updater. Enable integration and leave manual block off.
