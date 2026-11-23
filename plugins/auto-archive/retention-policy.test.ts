import { describe, expect, it } from "vitest";
import { DAY, effectiveRetentionDays } from "./policy.js";
import {
  DEFAULT_AUTOMATED_ORIGIN_PLUGINS,
  planArchivedFileCleanup,
  planAutomatedExportDelete,
  type RetentionConfig,
  type RetentionSnapshot,
} from "./retention-policy.js";

const NOW = 100 * DAY;

const baseConfig: RetentionConfig = {
  keepThreadIds: [],
  unarchiveGraceMultiplier: 2,
  enableArchivedFileCleanup: false,
  clearArchivedFilesAfterDays: 14,
  enableAutomatedExportDelete: false,
  exportDeleteAfterDays: 30,
  exportDir: "/tmp/example-exports",
  automatedOriginPluginIds: [...DEFAULT_AUTOMATED_ORIGIN_PLUGINS],
  retentionMaxPerRun: 50,
};

function snap(
  id: string,
  overrides: Partial<RetentionSnapshot> = {},
): RetentionSnapshot {
  return {
    id,
    title: id,
    titleFallback: null,
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    visibility: "visible",
    originKind: null,
    originPluginId: null,
    archivedAt: NOW - 40 * DAY,
    deletedAt: null,
    pinnedAt: null,
    status: "idle",
    busy: false,
    permanent: false,
    unarchiveCount: 0,
    lastUnarchivedAt: null,
    environmentId: null,
    environmentHostId: null,
    ...overrides,
  };
}

describe("effectiveRetentionDays", () => {
  it("scales exponentially by unarchiveCount and caps safely", () => {
    expect(effectiveRetentionDays(14, 0, 2)).toBe(14);
    expect(effectiveRetentionDays(14, 1, 2)).toBe(28);
    expect(effectiveRetentionDays(14, 2, 2)).toBe(56);
    expect(effectiveRetentionDays(14, 10, 2)).toBe(14 * 32);
    expect(effectiveRetentionDays(14, 3, 1)).toBe(14);
    expect(effectiveRetentionDays(5000, 5, 5)).toBe(36_500);
  });
});

describe("planArchivedFileCleanup", () => {
  it("selects old archived threads while protecting permanent, pinned, prefix, keep, busy, live, and unarchived-extended threads", () => {
    const threads = [
      snap("thr_old_manual", { archivedAt: NOW - 20 * DAY }),
      snap("thr_young", { archivedAt: NOW - 10 * DAY }),
      snap("thr_permanent", { archivedAt: NOW - 40 * DAY, permanent: true }),
      snap("thr_pinned", { archivedAt: NOW - 40 * DAY, pinnedAt: 1 }),
      snap("thr_prefix", { archivedAt: NOW - 40 * DAY, title: "📌 Important" }),
      snap("thr_kept", { archivedAt: NOW - 40 * DAY }),
      snap("thr_busy", { archivedAt: NOW - 40 * DAY, busy: true }),
      snap("thr_active", { archivedAt: NOW - 40 * DAY, status: "active" }),
      snap("thr_live", { archivedAt: null }),
      snap("thr_unarchived_once_young", {
        archivedAt: NOW - 20 * DAY,
        unarchiveCount: 1, // 14 * 2 = 28d -> still protected
      }),
      snap("thr_unarchived_once_old", {
        archivedAt: NOW - 30 * DAY,
        unarchiveCount: 1, // 14 * 2 = 28d -> eligible
      }),
    ];

    const plan = planArchivedFileCleanup(
      threads,
      { ...baseConfig, keepThreadIds: ["thr_kept"] },
      NOW,
    );
    expect(plan.candidates.map((c) => c.id)).toEqual([
      "thr_unarchived_once_old",
      "thr_old_manual",
    ]);
    expect(plan.skipped.permanent).toBe(1);
    expect(plan.skipped.pinned).toBe(1);
    expect(plan.skipped["pin-prefix"]).toBe(1);
    expect(plan.skipped["keep-thread-id"]).toBe(1);
    expect(plan.skipped["active-or-busy"]).toBe(2);
    expect(plan.skipped["within-retention-window"]).toBe(2);
  });
});

describe("planAutomatedExportDelete", () => {
  it("never deletes manually created visible root threads or user-facing plugin roots", () => {
    const threads = [
      snap("thr_manual_root", { archivedAt: NOW - 90 * DAY }),
      snap("thr_handoff_root", {
        archivedAt: NOW - 90 * DAY,
        originPluginId: "handoff",
      }),
      snap("thr_project_root", {
        archivedAt: NOW - 90 * DAY,
        originPluginId: "oxi-projects",
      }),
      snap("thr_fork_root", {
        archivedAt: NOW - 90 * DAY,
        originKind: "fork",
      }),
      snap("thr_workflow_root", {
        archivedAt: NOW - 90 * DAY,
        originPluginId: "workflows",
      }),
      snap("thr_hidden_root", {
        archivedAt: NOW - 90 * DAY,
        visibility: "hidden",
      }),
    ];

    const plan = planAutomatedExportDelete(threads, baseConfig, NOW);
    expect(plan.candidates.map((c) => c.id)).toEqual([
      "thr_hidden_root",
      "thr_workflow_root",
    ]);
    expect(plan.skipped["manual-or-live-owner"]).toBe(4);
  });

  it("allows deleting archived children of archived manual parents while keeping the manual parent", () => {
    const threads = [
      snap("thr_manual_parent", { archivedAt: NOW - 50 * DAY }),
      snap("thr_child_leaf", {
        parentThreadId: "thr_manual_parent",
        archivedAt: NOW - 40 * DAY,
      }),
      snap("thr_live_parent", { archivedAt: null }),
      snap("thr_child_of_live", {
        parentThreadId: "thr_live_parent",
        archivedAt: NOW - 40 * DAY,
      }),
    ];

    const plan = planAutomatedExportDelete(threads, baseConfig, NOW);
    expect(plan.candidates.map((c) => c.id)).toEqual(["thr_child_leaf"]);
    expect(plan.candidates[0].reason).toBe(
      "child-of-archived-or-missing-parent",
    );
  });

  it("blocks deleting an automated parent when any descendant is permanent, pinned, live, or too young", () => {
    const threads = [
      snap("thr_wf_root", {
        originPluginId: "workflows",
        archivedAt: NOW - 60 * DAY,
      }),
      snap("thr_wf_mid", {
        parentThreadId: "thr_wf_root",
        originPluginId: "workflows",
        archivedAt: NOW - 55 * DAY,
      }),
      snap("thr_wf_perm_leaf", {
        parentThreadId: "thr_wf_mid",
        originPluginId: "workflows",
        archivedAt: NOW - 50 * DAY,
        permanent: true,
      }),
      snap("thr_wf_sibling_leaf", {
        parentThreadId: "thr_wf_root",
        originPluginId: "workflows",
        archivedAt: NOW - 50 * DAY,
      }),
    ];

    const plan = planAutomatedExportDelete(threads, baseConfig, NOW);
    // Only the clean sibling leaf can be deleted; mid & root are blocked by perm leaf.
    expect(plan.candidates.map((c) => c.id)).toEqual(["thr_wf_sibling_leaf"]);
    expect(plan.skipped["protected-or-retained-descendant"]).toBe(2);
  });

  it("orders eligible trees strictly bottom-up (leaves before parents) so any prefix cap is safe", () => {
    const threads = [
      snap("thr_root", {
        originPluginId: "workflows",
        archivedAt: NOW - 80 * DAY,
      }),
      snap("thr_mid", {
        parentThreadId: "thr_root",
        originPluginId: "workflows",
        archivedAt: NOW - 70 * DAY,
      }),
      snap("thr_leaf", {
        parentThreadId: "thr_mid",
        originPluginId: "workflows",
        archivedAt: NOW - 60 * DAY,
      }),
    ];

    const plan = planAutomatedExportDelete(threads, baseConfig, NOW);
    expect(plan.candidates.map((c) => c.id)).toEqual([
      "thr_leaf",
      "thr_mid",
      "thr_root",
    ]);
  });

  it("excludes cycles and respects unarchive grace multiplier", () => {
    const threads = [
      snap("thr_cyc_a", {
        originPluginId: "workflows",
        parentThreadId: "thr_cyc_b",
        archivedAt: NOW - 60 * DAY,
      }),
      snap("thr_cyc_b", {
        originPluginId: "workflows",
        parentThreadId: "thr_cyc_a",
        archivedAt: NOW - 60 * DAY,
      }),
      snap("thr_unarchived_wf", {
        originPluginId: "workflows",
        archivedAt: NOW - 45 * DAY,
        unarchiveCount: 1, // 30 * 2 = 60d -> protected!
      }),
      snap("thr_unarchived_wf_expired", {
        originPluginId: "workflows",
        archivedAt: NOW - 65 * DAY,
        unarchiveCount: 1, // 30 * 2 = 60d -> eligible
      }),
    ];

    const plan = planAutomatedExportDelete(threads, baseConfig, NOW);
    expect(plan.candidates.map((c) => c.id)).toEqual([
      "thr_unarchived_wf_expired",
    ]);
    expect(plan.skipped["cycle-in-graph"]).toBe(2);
    expect(plan.skipped["within-retention-window"]).toBe(1);
  });
});
