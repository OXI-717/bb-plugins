# Automation triage draft

Add a Russian “Разобрать проблемы” header button using the existing parent-bound composer. Respect search/source/host/project/scope filters, but consider all status sections and pages. Include unhealthy, unmonitored, missing and paused one-shot records; ordinary intentional pauses are not failures. Show the count and scope in the button tooltip and draft. Opening is read-only and never spawns a thread or runs an automation.

1. Add pure candidate/prompt helpers with synthetic tests for scope, stale sources, archived tasks, bounded context and untrusted imported text.
2. Connect the header button and clarify generic composer copy; retain the host composer project/model choices and parent linkage.
3. Run focused helper/UI/compose tests, typecheck and build. Inspect public diff, independently review, and run remote CI.
4. Publish a patch release and install via managed update. Verify the draft in an owned headless browser without submitting it.

The prompt asks for live scheduler checks before changes, distinguishes observation errors from job failures, backs up before justified cleanup, preserves original schedulers and intentionally paused jobs, reports uncertain cases, and refreshes the catalog after changes. Limit embedded context to 40 tasks and direct the agent to fetch omitted candidates from the current catalog. No model is invoked until the user submits the draft.
