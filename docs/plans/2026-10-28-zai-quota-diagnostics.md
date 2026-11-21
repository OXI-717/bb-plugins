# Z.AI quota collection

Base: `80a55b4ae9fa60b01d1454e28adc16c02905f202`.

1. Reproduce refresh through the existing pool backend. Distinguish a successful
   command from a successful measurement; record only sanitized evidence privately.
2. Make Z.AI collection failures visible through the existing refresh and usage
   RPC paths. Include HTTP status and a fixed, allowlisted structural summary;
   never include response values, arbitrary keys, credentials, or upstream messages.
   Preserve inference headers and other providers. Keep quota request authorization
   unchanged until a real response establishes whether it is rejected.
3. Validate known legacy token windows strictly: missing and invalid percentages
   must remain unknown; zero and full consumption are observations. Preserve
   an omitted previously observed window during a partial response.
4. Run focused parser, adapter, and usage tests, typecheck, and plugin build.
   Freeze the candidate commit for independent review before any live application.
5. After coordinated application, collect the real safe response through the
   native backend. Extend authentication or credit parsing only from that evidence.
   Do not infer plan tiers, units, renewal dates, or credit schemas.

## Evidence and limits

The installed backend returns success without exposing HTTP or parse failures.
The official pinned usage script uses a direct authorization value, whereas the
current adapter uses Bearer. This difference alone does not establish the cause.
The plan notice describes credit and legacy subscriptions, but does not specify
the monitoring endpoint's credit response schema. A synthetic credit payload is
not evidence that a real subscription can be measured.

References:
- https://github.com/zai-org/zai-coding-plugins/blob/64cebffd62b9ade133a473e5d169e0e8c895441c/plugins/glm-plan-usage/skills/usage-query-skill/scripts/query-usage.mjs
- https://docs.z.ai/devpack/notice/usage-revision
- https://docs.z.ai/devpack/notice/api-key-management

## Dependency preparation

Pin the existing production dependencies to `undici` 7.30.1 and `zod` 4.6.7,
preserving all other lockfile resolutions. This addresses the production audit
gate without adding packages or changing majors. It does not establish that
every upstream advisory is exploitable in this application.

Run production audit, existing transport/request-body/quota/usage tests,
typecheck and the official plugin build with the updated lockfile. Review the
complete diagnostic and dependency delta at the new frozen commit before any
live application; quota authentication and unknown credit schemas stay unchanged.

Dependency references:
- https://github.com/nodejs/undici/security/advisories/GHSA-2m5v-pch6-74hx
- https://github.com/colinhacks/zod/releases/tag/v4.6.6
- https://github.com/colinhacks/zod/releases/tag/v4.6.7

## Observed credit fields and documented window interpretation

A sanitized diagnostic response established exact CREDIT_LIMIT rows with
(unit, number) pairs (3, 5) and (6, 1), plus a recognized data.level.
The official [Usage Credit Allowance](https://docs.z.ai/devpack/overview#usage-credit-allowance)
documents five-hour and weekly windows and their plan allowances. Together with
the observed fields and legacy unit interpretation, this corroborates the
restricted mapping of these pairs to five-hour and weekly windows. It is not an
independent temporal measurement or a universal specification of numeric codes.
Reject unknown or conflicting credit combinations rather than guessing a duration.
Preserve legacy token windows. Use the reported percentage directly, including
zero and 100, and retain cached omitted windows. Do not derive consumption or cost from counters.

Only successful quota parsing may update the existing account subscription
metadata through a serialized setter. Accept only lite/pro/max; clear an unknown
level to null, skip unchanged values, and preserve all other account fields.
The existing usage RPC reads this metadata after refresh. No storage migration,
new collector, dependency, or authentication change is required.

Reproduce the previous rejection with a synthetic fixture, then validate the
parser, storage, refresh and usage RPC path with fake fetch and isolated test
storage, plus typecheck and the official build. Freeze for independent review.
Live application still requires coherent KV/quota/secret backup and restoration
and a supported source replacement; plugin-directory copies alone are partial.
