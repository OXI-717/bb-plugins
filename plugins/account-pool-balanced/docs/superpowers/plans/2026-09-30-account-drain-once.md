# One-shot account draining

**Goal:** Allow one account to bypass pool caps until the first provider quota is exhausted, then automatically restore normal routing. Manual provider resets never re-enable it.

**Architecture:** Persist a per-account override in AccountStore; expose a validated RPC and checkbox. Keep original role/cap intact. Membership admits an armed reserve alongside primaries. New unbound requests prefer armed candidates; affinity stays intact. Use threshold 1 while armed; real blocked statuses remain authoritative. Clear on observed exhausted shared or model quota, refresh or an explicit quota rejection, never on generic pacing or transport errors.

**Plan (inline execution):**
- Add focused balancer and server tests for reserve cap bypass, priority and automatic clearing.
- Extend contracts/store/operations/RPC and selection/status/refresh handling. Ensure legacy accounts default off and clearing survives reload.
- Add account-card checkbox and accurate effective-threshold text; document usage.
- Run focused tests, typecheck and plugin build. Review complete diff and leave live plugin unchanged pending manual upgrade.

**Accepted behavior:** First exhausted quota ends the override. No assumed 5-hour window for Codex. No automatic redemption, rearming or movement of already bound conversations.
