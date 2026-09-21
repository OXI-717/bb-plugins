# Public BB plugins

- This repository is the source of truth for its public plugins. Keep internal integrations in their own repository; do not maintain a second source copy here.
- Keep plugin IDs stable: they own persisted settings, secrets and routing.
- Publish immutable per-plugin tags (`account-pool-balanced/vX.Y.Z`). Never move an existing tag.
- Treat source, tests, documentation, issues, commit messages and CI logs as public.
- Use repository-relative paths, the BB host SDK, configuration and temporary directories. Never embed personal home paths, deployment addresses, customer names or real account inventories.
- Fixtures must be synthetic. Credentials, databases, authentication files and backups never belong in Git.
- Secrets belong in server-side storage. Do not put them in CLI arguments, logs, browser responses or screenshots.
- Preserve upstream licenses and attribution. Build from the published SDK without private workspace dependencies.
- Before the first push of imported content, run the owner's local publication gate and inspect the complete staged diff and commit metadata. Public CI cannot prevent a first-push disclosure.
- Keep private publication denylists outside this repository; publishing them would disclose the names they protect.
- Run typecheck, focused tests and `bb plugin build .` for changes. The full suite runs in GitHub Actions. Do not run an expensive full suite locally on macOS without explicit approval.
- Never remove or reload a live pool without considering active requests, a verified state backup and a rollback path.
