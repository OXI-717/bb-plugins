# Thread machine marks implementation plan

> Execute inline using superpowers:executing-plans; the owner approved the design and implementation.

**Goal:** distinguish execution machines without renaming sessions.
**Architecture:** isolated machine-marks policy, DOM lifecycle, RPC/settings, frontend hook components; wire into existing Projects entries.
**Stack:** TypeScript, Zod, React, public BB SDK, Vitest/jsdom.

- [ ] Add failing policy tests for stable-ID roles, custom palette, missing host, disabled/invalid settings and escaping. Add DOM tests for unchanged provider/status/title, moving/recycled rows, dynamic data, host rename, editor skipping, narrow footprint and cleanup.
- [ ] Implement machine-marks.ts and machine-marks-dom.ts with a strict bounded settings schema, data store, idempotent reconciliation and generation cleanup. Run `npx vitest run machine-marks.test.ts machine-marks-dom.test.ts`.
- [ ] Add backend harness tests for invalid config, roster/read failure, preserving settings, successful saves and per-thread host reads. Implement machine-marks-server.ts and register from server.ts.
- [ ] Add machine-marks-view.tsx: one sidebar-data controller feeding the content script, header mark and settings form (enabled checkbox, per-host role/palette, explicit save/retry and accessible errors). Extend app registration; verify render tests and typecheck.
- [ ] Document settings/runtime contracts, update standard focused check to include marks tests, bump public version. Run standard plugin check; run private focused check after identical module backport and private version bump.
- [ ] Apply private publication gate and secret scan, open PRs with impact/protection/cost/terminal decision, obtain independent review, consolidate material findings once, await final-head CI, accept and publish immutable tags.
- [ ] Update existing private installation preserving config, set only machine marks mapping for the confirmed local/primary identities, live isolated visual checks (never copy personal cookies), record limitations, close browser and own worktrees.

Acceptance budget: one independent review and one repair pass; focused feedback first, CI once on final executable code, retry only concrete infrastructure failures. No expensive local full suites.
