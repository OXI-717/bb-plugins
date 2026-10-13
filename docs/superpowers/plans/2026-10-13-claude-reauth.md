# Claude OAuth recovery

Persist terminal OAuth refresh rejection during usage checks, enabling and routed requests. Preserve disabled accounts, settings and IDs. Extract only a bounded allowlisted OAuth error code, never raw provider response bodies. Treat invalid_grant as rejected refresh authorization; do not infer revocation cause from HTTP 400 alone. Temporary network/VPN failures remain retryable and never become permanent authorization errors.

Add a target-bound Claude reauthorization session and card button. Verify the completed profile matches the existing account identity before writing tokens; preserve role/priority/projects/policy/enabled. Normal add-account login remains unchanged. No live deletion, enable, token replacement or re-login without user interaction.

Tests: terminal refresh persists without routed model call; transient failure does not poison; reauthorization preserves ID/settings, refuses a different identity and removed target; UI shows action. Run focused tests/typecheck/build, publication gate, CI and independent review before release. User completes browser authorization separately after installation.
