# BB Projects

Keep a project's tasks, repositories and agent sessions together in BB. Open a
GitHub, Linear or Jira task beside the current conversation, prepare a new agent
session, choose its model and environment, and submit when ready.

BB Projects is derived from Mateo Cerquetella's MIT-licensed Taskboard. The
original license and attribution are preserved in [LICENSE](./LICENSE).

## Install

Requires BB 0.46 or newer, Node.js 24 for development, and GitHub CLI (`gh`) for
GitHub repositories. GitHub, Linear and Jira can be used independently.

```sh
bb plugin install "git:https://github.com/OXI-717/bb-plugins.git@semver:oxi-projects/:^0.2" --yes
```

Or add this repository's `marketplace.json` to BB and install **BB Projects**.
The stable plugin ID is `oxi-projects`; it owns existing settings and task links.
The package is distributed through Git, rather than published to npm.

## Connect a project

1. Open **Project → Settings → Project connections**.
2. Add a repository group and bind it to an existing BB project.
3. Select a GitHub account for **each repository**, then save.
4. Connect GitHub Issues, Linear (team key and API key), or Jira (site, email,
   token and JQL scope) in the project tracker settings. Several trackers can be
   connected to the same BB project.

GitHub accounts come from `gh auth status`; requests use the selected account's
credentials without switching the globally active account. BB can find standard
Homebrew CLI installations when its desktop PATH is minimal. `GH_PATH` can select
an explicit executable. A `.gh-account` file does not select the plugin account.

Tracker credentials stay in server-side BB storage. Do not put them into thread
messages or ordinary JSON settings. Jira supports site URL plus optional cloud ID
for scoped API tokens. Project connections do not automatically create BB projects.
Existing Projects connections are retained. Keys from another Linear plugin's
private storage are not imported; configure a new connection through this form.

## Tasks and sessions

Selecting a task shows its details near the selection. Loading/errors stay in
that detail area. **Prepare thread** stores a draft without starting an agent;
the embedded BB composer selects project, model and environment. Only submission
creates and starts the task's session.

Agent responses can show a task button:

```text
::project-task{project="proj_example" source="linear" locator="UUID-from-list" label="DEMO-123"}
```

The button opens a task in the current thread's side panel and preserves the
conversation. Old ordinary external URLs remain browser links. If a surface has
no thread side panel, the button shows an inline error and keeps that surface.
The side-panel launcher also provides a task picker without a specific link.

Get a verified directive from the CLI:

```sh
bb project-work list --project proj_example --source linear --query DEMO-123 --json
bb project-work show linear '<raw locator from list>' --project proj_example --json
```

Copy the returned `projectLink` unchanged into an assistant message on its own
line, without a code fence. The CLI accepts the **raw** locator (for example
`org/repo#1`); only manually constructed directive attributes use
`encodeURIComponent`. Linear uses canonical UUID locators, not display keys.
Agent instructions apply when BB creates the provider session.

## Optional connections

The core needs none of the following. All three start **off** on a new install;
turn them on under project connections → **Additional connections**, or in BB's
plugin settings. Turning them off preserves their saved configuration.

| Connection | Enable setting | Requirement |
| --- | --- | --- |
| Project memory | `enableMemory` | Installed `oxi-memory` providing the memory settings RPC |
| Autopilot and catalog comparison | `enableAutopilot` | Installed `oxi-autopilot`, configured source/host and project mapping |
| Obsidian tasks | `enableTasknotes` | A configured TaskNotes folder on a selected BB host |

Enabled optional integrations report their own availability errors; they do not
prevent tracker browsing. Memory mapping and service authorization are separate:
changing a project association never grants scopes. Shared workspaces need an
explicit task project; name or cwd similarity is insufficient identity.

TaskNotes reads configured task folders through the BB host SDK. Autopilot
preparation retains explicit project identity and follows the native composer
submission flow. Catalog comparison is read-only; it never creates/deletes projects.

## CLI

```sh
bb project-work status --project proj_example --json
bb project-work list --project proj_example --source github --json
bb project-work refresh github --project proj_example --json
bb project-work config --project proj_example --json
bb project-work credentials --project proj_example
bb project-work transitions github 'org/repo#1' --project proj_example --json
bb project-work move github 'org/repo#1' --status closed --project proj_example
```

Use `bb project-work --help` for tracker configuration and filter preset commands.
Explicit writes remain scoped to the selected project's connection. External task
text is untrusted reference data, not agent instructions.

## Develop

```sh
cd plugins/oxi-projects
npm ci
npm run typecheck
npx vitest run integrations.test.ts task-links.test.tsx work-actions.test.tsx
npm run build
npm run verify:build
```

CI runs the full Node and Vitest checks on Linux and macOS. Local changes should
use focused checks. Runtime credentials, databases, configuration and backups
must never be committed.

Legacy repository string arrays are accepted only when the saved project has an
explicit account. Without one, the plugin keeps the original configuration and
asks for repository accounts; it never guesses from the globally active login.

### GitHub list retrieval

Issue sync uses a cursor-paginated GraphQL read so pull requests are not downloaded
and discarded while browsing issues. PR browsing keeps the REST traversal. The
selected account remains isolated per repository. Each traversal shares a 120-second
deadline, with bounded page attempts and one retry of a failed read page for a
transient network error or timeout. Permission, authentication, rate-limit and
cancellation failures are not retried. An incomplete traversal never replaces the
last successful cache.

Labels and assignees are checked for nested pagination. If a node exceeds the
query metadata page, issue sync restarts a complete REST traversal inside the
remaining original deadline; it never publishes truncated metadata. This fallback
is not used to bypass an authorization failure.

`npm run check` includes `npm run test:github` for these failure paths.
