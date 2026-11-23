import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makePluginProject, makeSidebarThread } from "../app/model/fixtures.js";
import { defaultPreferences } from "../shared/preferences.js";
import { setPreferencesMirrorStorageForTest } from "../app/preferences/preferences-sync.js";
import { createElement } from "react";

const laptop = { id: "host_laptop", name: "Mac" };
const server = { id: "host_server", name: "Сервер" };
const threads = [
  makeSidebarThread({ id: "thr_parent", projectId: "proj_app", title: "Подготовить выпуск", host: laptop }),
  makeSidebarThread({ id: "thr_child", projectId: "proj_app", title: "Проверить на сервере", parentThreadId: "thr_parent", host: server }),
  makeSidebarThread({ id: "thr_build", projectId: "proj_app", title: "Собрать приложение", host: server }),
  makeSidebarThread({ id: "thr_mobile", projectId: "proj_site", title: "Проверить мобильную версию", host: laptop }),
  makeSidebarThread({ id: "thr_site", projectId: "proj_site", title: "Обновить сайт", host: server }),
];
const app = await loadPluginApp(() => import("../app.js"));
// Test SDK icons are empty spans. Give the synthetic preview visible control glyphs.
const host = globalThis as typeof globalThis & { __bbPluginRuntime: { pluginSdkApp: Record<string, unknown> } };
host.__bbPluginRuntime.pluginSdkApp.experimental_Icon = ({ name, ...props }: { name: string; className?: string }) => {
  const paths: Record<string, string> = {
    ChevronRight: "M9 5l7 7-7 7", ChevronDown: "M5 9l7 7 7-7", ChevronLeft: "M15 5l-7 7 7 7",
    Laptop: "M4 4h16v13H4zM2 20h20", MoreHorizontal: "M4 12h1m6 0h1m6 0h1",
    MessageSquarePlus: "M4 4h16v13H9l-5 4zM8 10h8m-4-4v8", Check: "M4 12l5 5L20 6",
  };
  return createElement("svg", { ...props, "data-icon-root": "", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true },
    createElement("path", { d: paths[name] ?? "M5 5h14v14H5z" }));
};
setPreferencesMirrorStorageForTest(null);
const compact = innerWidth < 768;
renderSlot(app.threadLists[0]!, {
  activeThreadId: null, activeProjectId: null, isCompactViewport: compact, searchQuery: "", onNavigate() {},
}, {
  pluginId: "oxi-thread-list",
  sidebarThreads: {
    projects: [makePluginProject({ id: "proj_app", name: "Приложение" }), makePluginProject({ id: "proj_site", name: "Сайт" })],
    threads,
  },
  rpc: {
    listPreferences: () => ({ preferences: { ...defaultPreferences(), organizationMode: "project" } }),
    setPreference: (input: unknown) => input,
  },
});
document.querySelector("body > div")?.setAttribute("data-sidebar", "content");
document.querySelector("body > div")?.setAttribute("data-preview-root", "");
