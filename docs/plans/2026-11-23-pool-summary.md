# Cached pool summary

Expose a fixed set of provider quota signals through `bb pool status --summary`.
Verify the exact public CLI command, closed payload, stored evidence and unknown
states. Stop at a reviewed candidate. Deploy through the normal release process.

- Use metadata and quota storage only. Keep detailed status under management access.
- Suppress the exact usage percentage when fewer than two accounts are enabled.
  Counts and repeated samples can still reveal operational activity.
- The consumer validates the schema and treats unknown headroom explicitly.

For project admission, add `bb pool readiness --summary --project <id>`
inside the existing read-grant command. Return only the check time and the
provider readiness, with existing fixed reason codes. Use the current native
checks for the requested project. Verify no-grant denial, missing project
rejection, and the response shape. Leave ordinary readiness unchanged.
