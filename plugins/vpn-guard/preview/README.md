# Isolated panel preview

From the plugin directory, run `npm ci`, `npm run preview:build`, then serve `preview/` with any static HTTP server. This renders the actual `GuardPage` component with synthetic in-memory RPC data. It never connects to BB, VPN hosts, providers or the automation controller. Generated bundles are ignored by Git.

Query parameters: `lang=ru|en`, `theme=light|dark`, `pane=320|390|1024`, `long` for a long machine name, and `scenario=unknown|recovery|error`. The default shows a connected machine and no recovery pending. Unknown evidence disables restore; recovery opens native plugin settings; error simulates a failed status read. Preview actions are local simulations and unsupported actions return an explicit error.

Check mobile viewports and a narrow `pane=320` inside a wide desktop viewport. Normal vertical page scrolling remains available when detailed configuration is open; the component does not add a nested scroll container.
