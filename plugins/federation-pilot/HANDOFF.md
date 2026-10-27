# Independent-server handoff bridge

The matching Handoff plugin uses fixed primary-side plugin RPCs to list remote
ready environments, discover their providers/models, prepare a transfer, upload
manifested files, create one thread and inspect the result. This is separate from
the agent read-only API; it registers no send/create agent tools.

Every operation names server, project, host and environment. The selected
connection must allow writes. Fresh environment membership, host connection,
primary/cross-server ownership and the full connection configuration are checked
before upload/create. A local ID never sends bytes upstream. SSH and networking
are unchanged; uploads use the existing outward tunnel and caller-supplied bytes.

Files are bounded to 4 MiB each, 16 MiB total and 16 parts. SHA-256, byte length,
filename extension and allowed MIME type are checked; raster signatures/PDF header
and text UTF-8 are validated. This does not scan file contents for sensitive data.
The user must choose an appropriate source snapshot and attachments. No arbitrary
host file path, URL, HTTP method or credential headers are accepted.

Transfer operations have persisted states and an in-process lock. State is saved
before each upload and before creation. An interrupted/inconsistent operation is
not automatically retried, including after reload. A created ID is retained when
known, even if later validation fails. A successful creation response is not model
completion. Uncertain operations and uploaded orphan files require manual review.

The Handoff UI stays on the primary server for the exact remoteTargets,
remoteOptions, remotePrepare, remoteStart and remoteStatus RPCs. All other plugins'
RPC restrictions remain unchanged. This is an integration contract, not a separate
security sandbox for agents that already possess shell or direct HTTP access.

No machine enrollment, source parent/lifecycle link, reverse callback, agent
forwarding, directory sync or primary credentials are added. Independent network
reachability remains outside the plugin's guarantees. Existing read/write settings
are preserved; `allowAgentReads` is not enabled by this feature.
