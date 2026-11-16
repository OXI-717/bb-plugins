import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";

// Older BBs supplied goal activity; newer SDKs omit it. Keep old snapshots readable.
export type SidebarThread = Omit<PluginSidebarThread, "activity"> & {
  activity: PluginSidebarThread["activity"] & { goals?: number };
};
