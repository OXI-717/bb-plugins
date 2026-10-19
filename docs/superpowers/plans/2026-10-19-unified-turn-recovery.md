# Unified turn recovery

Goal: recover transient pooled network failures and new Guard-owned stops using supported BB dispatch, without modifying BB or reviving user-owned work.

Architecture: Pooler schedules native retry for typed connection/stream failures on pooled routes, capped at three additional attempts (30s,120s,300s with jitter). It excludes built-in overload/quota retries, permanent errors, bypassed routes and existing queue entries. Core retains the original retry chain and accepted-input semantics. Guard remains the admission gate during outage; a waiting dispatch consumes no new attempt.

Installed BB requires status=error for native retry. Guard's ordinary stop produces idle. For newly recorded Guard stops only, retain durable recovery intent, then perform the existing checked continuation after proof/native restoration, outside the serialized enforcement lane. Historical stop records are not imported. Manual block remains a hold until explicitly released; later thread activity/archive/delete/queue prevents automatic continuation. Uncertain sends retain their claim; never blindly repeat a possible dispatch. The supported SDK cannot atomically compare an idle thread and send; this residual boundary must remain explicit.

VPN refusals become temporary-unavailable responses with stable VPN reason codes and Retry-After, distinct from authentication/access-denied. Never relabel network failure as provider overload solely to trigger built-in retry.

Tasks:
- [ ] Regression tests for native retry classification/cap/queue/core handoff and route scope.
- [ ] Implement small retry module; integrate with Pooler lifecycle; verify protocol errors.
- [ ] Regression tests and durable automatic continuation of new Guard-owned stops; preserve manual recovery and enforcement isolation.
- [ ] Focused suites, both typechecks/builds, public checks and independent fault/concurrency review.
- [ ] Full CI on final SHA; controlled live synthetic recovery check; immutable paired release and idle/backup upgrade.
