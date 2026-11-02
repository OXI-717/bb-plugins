# Pooled provider readiness

`bb pool readiness --project <project-id> --json` reports one fixed-size entry
per pooled provider, with project ID, observation time, readiness and a fixed
reason. Omit `--project` to inspect unbound routing. The administrative
`readiness.get` RPC exposes the same bounded snapshot.

The snapshot uses existing project access, roles, schedules, quota thresholds,
reserve rules and cooldowns. Inspection does not finish a drain, change flags,
select an account, refresh quota or send a provider request. Existing network
policy is checked and stored credentials must be readable. A failed network
check produces a fixed reason rather than propagating diagnostic contents.

Readiness is advisory and provider-level, not a model catalog or a guarantee
that a request will succeed. Dispatch still enforces its current model-family
quota, capacity, purpose and project rules. Native BB separately checks launcher
installation on the selected machine. No account identifiers, request contents
or credentials are included in this readiness response.

When routing is enabled, managed launch environments keep the pool endpoint and
scoped credentials even when every account is unavailable. This prevents a
missing pool account from silently selecting a local provider login. An explicit
routing disable or existing per-thread bypass retains its prior behavior.

Compatible native BB readiness consumers pass the selected project to the
existing experimental environment-health contribution and understand negative
status. Older BB versions omit project context; the plugin withholds a positive
proxy-health answer on denial rather than presenting a negative answer as ready.
Native picker filtering and periodic checks require the corresponding BB core
change; installing this plugin alone does not update the picker. No separate
provider-selection plugin is required or enabled.
