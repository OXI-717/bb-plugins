# Upstream provenance

The renderer (`app/`, `app.tsx`), original preference model and server command
store derive from the thread-list plugin in [get-bb/bb](https://github.com/get-bb/bb),
as of commit `d4af92823b265bd69f42ed7a3e7d7818006911fd`.

`vendor/shared-ui` contains only the transitive UI source imports required by
the renderer. Its source is the shared-ui source in that repository
(latest change there: `7877c1c7316e6f68dec3bb1f337158e4a55cd9dd`). The icon
adapter is from the plugin-registry flavor icon adapter and
delegates to the published SDK icon component. No BB database, installed bundle,
user configuration, credentials, attachments or conversation data are included.

All imported source is covered by the upstream MIT notice in [LICENSE](./LICENSE).
Retain that notice on redistribution. The standalone package removes private
workspace imports and uses the published SDK. New code adds project-machine
grouping, per-project preferences and validated one-time preference import.
Compatibility with SDK 0.6.132 keeps legacy optional goal activity readable and
maps its former glyph to the current runtime glyph; absent goal activity is idle.

The retained tests exercise the original list modes, row interactions, navigation,
drag-and-drop, disclosure, ordering and preferences. Goal glyph expectations are
updated to match the current SDK. New grouping and import tests are separate.
