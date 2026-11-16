# OXI Session Tree

A standalone BB sidebar provider: projects first, optional machine groups inside
each project. Requires BB 0.49+. It uses the public plugin SDK and does not patch BB.

## Controls

Choose **OXI Session Tree** under BB Settings → Sidebar → Thread list, or use
Automatic when this is the only third-party list provider. The bundled **Thread
list** provider stays installed and can be selected again at any time.

In a sidebar header menu, choose **Organize → By project**, then toggle
**Машины внутри проектов**. In a project's menu, **Машины в этом проекте** offers
three choices: inherit the global setting, group by machine, or show no machine
groups. Other projects keep their own choices. These settings are shared between
clients of the same BB server, like the original list preferences.

Only root branches are assigned to a machine group. A child on another host stays
under its parent, with its own existing machine icon. Roots with no host appear
under **Без машины**. Host identity comes from the sidebar feed, never a folder
name. Group headings can collapse independently per project. Opening a thread
through navigation reveals its machine group and ancestors. Pinned branches keep
their separate pinned section. Chronological and top-level machine modes retain
their original behavior.

The first load copies validated preferences from the bundled `thread-list`
provider through its public RPC, without writing to it. Sort order, row actions,
hidden groups and collapse preferences are preserved. The import runs once and
never overwrites this provider's existing settings. If the source cannot be read
or validated, registration fails; keep using the bundled provider and retry the
plugin after resolving that error. Later changes to either provider are separate.

Machine grouping adds no polling, history reads, model calls or remote mutations.
It reorganizes the already loaded sidebar model. Original sidebar subscriptions,
row metadata and configured row actions keep their existing behavior. Federation
uses its existing transport and permission checks; this plugin grants no new
remote permissions. A remote machine unavailable to that transport stays unavailable.

## CLI

`bb oxi-thread-list prefs list --json` lists the current preferences.

- `projectMachineGrouping`: global boolean, defaults to `true`.
- `projectMachineOverrides`: object mapping project IDs to `machines` or `plain`;
  absence means inherit. Example: `{"proj_demo":"plain"}`.
- `collapsedProjectMachines`: internal list of structured project/host keys.

Other preference keys follow the bundled list contract. Resetting the new keys
does not change native settings or thread data. The plugin does not create,
start, stop, archive or relocate threads to apply a grouping preference.

## Development and provenance

Run `npm ci`, `npm run typecheck`, `npm test`, and `bb plugin build .`.
The suite retains upstream behavior checks and adds hierarchy, override,
preference-import, mixed-host, missing-host and cyclic-graph regressions.

The list renderer and the dependency closure of its UI primitives are derived
from BB's MIT-licensed bundled plugin. See [UPSTREAM](./UPSTREAM.md) and
[LICENSE](./LICENSE). These vendored files are plugin source, not modifications
to the installed BB application. Shared UI stays local to this package; SDK,
React and host UI behavior use their published runtime contracts.

For an upstream refresh, review the list renderer and shared UI dependency closure
together, preserve the license, rerun all tests against the pinned published SDK,
and inspect desktop and phone screenshots. Do not replace files from an installed
BB bundle or copy workspace dependencies into the published manifest.
