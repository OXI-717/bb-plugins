# Auto Archive tree safety

Fork upstream Auto Archive 0.1.0 under its original MIT license. Use the public
SDK, preserve plugin identity, and ship auto-archive/v0.2.0. Default to a 14-day
window and preview-only operation. Preserve the pre-install backlog boundary.

Selection follows parent, lifecycle owner and hidden source cascade edges.
Protected descendants block ancestors. Active branches can be detached only
through supported mutable parent links. Immutable lifecycle ownership blocks
unsafe operations. Manual prune preserves a live target and its subtree while
selecting quiet ancestors and side branches. Workspace status is read through
SDK; unknown and dirty status protects the tree. Revalidate before mutations,
serialize operations, and document the remaining non-atomic archive race.

Validation: synthetic policy and fake SDK execution tests, typecheck, published
CLI build, hygiene/manifests/docs gates, independent review and remote CI.
After acceptance, merge, publish immutable plugin tag and install in dry-run
mode. Report preview counts and pre-install backlog separately.
