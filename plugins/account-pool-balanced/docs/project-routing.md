# Project routing

In an account card, use **Projects** to select where the subscription may be used
and its role in each project. Changes save immediately.

- **All projects**: the account is also a general fallback outside the listed projects.
- **Selected only**: a nonempty list restricts the account to those projects.
- An empty list always means unrestricted use.
- Each row can inherit the account's default role, or override it as primary or reserve.

Selection order is **project primary → project reserve → general primary → general reserve**.
Within a tier, the configured routing strategy and existing quota policies apply.
The reserve's existing drain-before-reset window can promote it within its own
project/general group. Quota thresholds, progressive caps and schedules remain
account-wide; they are not separate quotas for each project.

**Use until exhausted** overrides project restrictions, roles, schedules and pool
quota thresholds while armed. Disabled accounts, authentication errors and actual
provider limits still apply. The setting clears on the first observed exhausted
provider window; it does not perform a provider reset.

BB supplies a project-bound hub token automatically when it starts a routed
provider. Project identity comes from that token, not a caller-supplied project
header. Sessions and active-account cursors are isolated by project. Changing
project rules takes effect on the next request, including an existing session.
After upgrading from a version without project-bound tokens, restart existing
provider sessions to acquire project identity. Their old tokens remain unbound;
the hub cannot infer a project from them. Newly started sessions bind automatically.
Project names are only display labels; rules store stable BB project IDs.
Unavailable projects remain listed so their restrictions are not silently lost.

## CLI and external clients

Set account rules with synthetic IDs replaced by your actual IDs:

```sh
bb pool account projects ACCOUNT_UUID '{"onlySelected":true,"rules":[{"projectId":"PROJECT_ID","role":"primary"}]}'
bb pool account projects ACCOUNT_UUID off
bb pool client add project-client --output NEW_PRIVATE_TOKEN_FILE --project PROJECT_ID
```

Use the issued token with the normal [external-client setup](external-clients.md).
An unbound client has no project identity and can use only general accounts or an
account with **Use until exhausted** armed. Revoking the client also revokes its
project tokens. Rotating a machine token rotates its project tokens with the same
10-minute grace period. Removing a machine removes its project tokens.

Standalone `client-add` also accepts `--project PROJECT_ID`; standalone account
imports accept the same `projects` field. Projects are operator-defined IDs there.

Devin Local CLI uses the same hub rules. A BB ACP launcher must run the current
`scripts/devin-pool.mjs`, which reads `OXI_DEVIN_POOL_TOKEN` and
`OXI_DEVIN_POOL_URL` contributed by BB. If you installed a separate launcher copy,
update that copy as well. The separate experimental Devin cloud-session API does
not use these account routing rules.
