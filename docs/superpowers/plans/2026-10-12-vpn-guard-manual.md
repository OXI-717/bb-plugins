# VPN Guard manual block and bilingual UI

Goal: persistent manual block on selected machines regardless of VPN or Observe, with Russian/English controls following the existing Pooler visual standard.

Architecture: configuration-v2 gains a default-false manualBlock field to preserve old configuration. RPC/CLI serialize writes using the existing policy version and recheck path. Dispatch and reconciliation share the same manual override; restore is forbidden while manually blocked. UI shows actual VPN separately from effective block, remembers language in local storage and uses host theme tokens.

- [x] Add regression tests for connected/Observe block, scope and Chinese exclusions, persistence, unblock returning to prior mode, empty scope, native restore fence and old configuration migration. Run focused tests and verify new tests fail.
- [x] Extend contract/server with manualBlock, setManualBlock RPC and block/unblock CLI. Run focused tests and typecheck.
- [x] Replace English-only UI with RU/EN copy, common compact controls, clear block state and preserved operational limits. Document shared UI standard and bilingual operations.
- [x] Build, install candidate only in isolated BB, inspect real rendered UI at 320/390/desktop widths in both languages, exercise RPC/CLI without live enforcement. Record evidence and review diff.

No production manual block, native suspension, system VPN changes or full local repository suite are part of this implementation. Release/publication requires source hygiene and independent review before production upgrade.
