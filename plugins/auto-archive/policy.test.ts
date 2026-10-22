import { describe, it, expect } from "vitest";
import {
  countThreadExclusions,
  planSweep,
  planPrune,
  DAY,
  type Snapshot,
  type Config,
} from "./policy.js";
const now = 100 * DAY;
const config: Config = {
  inactivityDays: 14,
  sinceInstallAt: DAY,
  keepThreadIds: [],
  detachActiveDescendants: false,
};
const t = (id: string, extra: Partial<Snapshot> = {}): Snapshot => ({
  id,
  title: id,
  parentThreadId: null,
  lifecycleOwnerThreadId: null,
  sourceThreadId: null,
  visibility: "visible",
  latestAttentionAt: 70 * DAY,
  status: "idle",
  pinnedAt: null,
  workspace: "clean",
  ...extra,
});
const ids = (p: ReturnType<typeof planSweep>) => p.actions.map((a) => a.rootId);
describe("archive policy", () => {
  it("uses inclusive 14 day cutoff, preserves install backlog", () => {
    expect(
      ids(
        planSweep(
          [
            t("edge", { latestAttentionAt: 86 * DAY }),
            t("fresh", { latestAttentionAt: 86 * DAY + 1 }),
            t("backlog", { latestAttentionAt: 0 }),
          ],
          config,
          now,
        ),
      ),
    ).toEqual(["edge"]);
  });
  it.each(["parentThreadId", "lifecycleOwnerThreadId"] as const)(
    "recent descendant through %s protects root",
    (key) => {
      expect(
        ids(
          planSweep(
            [t("root"), t("child", { [key]: "root", latestAttentionAt: now })],
            config,
            now,
          ),
        ),
      ).toEqual([]);
    },
  );
  it.each([
    { pinnedAt: 1 },
    { title: "📌 permanent" },
    { id: "keep" },
    { workspace: "dirty" },
    { workspace: "unknown" },
  ] as Partial<Snapshot>[])(
    "protects every member and ancestor: %j",
    (extra) => {
      expect(
        ids(
          planSweep(
            [t("root"), t("child", { parentThreadId: "root", ...extra })],
            { ...config, keepThreadIds: ["keep"] },
            now,
          ),
        ),
      ).toEqual([]);
    },
  );
  it("archives a quiet multi-level tree once", () => {
    expect(
      planSweep(
        [
          t("r"),
          t("c", { parentThreadId: "r" }),
          t("g", { lifecycleOwnerThreadId: "c" }),
        ],
        config,
        now,
      ).actions[0].archiveIds,
    ).toEqual(["r", "c", "g"]);
  });
  it("detaches recent parent-linked branch with its descendants", () => {
    const p = planSweep(
      [
        t("r"),
        t("c", { parentThreadId: "r", latestAttentionAt: now }),
        t("g", { parentThreadId: "c" }),
      ],
      { ...config, detachActiveDescendants: true },
      now,
    );
    expect(p.actions[0]).toEqual({
      rootId: "r",
      detachIds: ["c"],
      archiveIds: ["r"],
    });
  });
  it("cannot detach immutable owner or hidden source dependencies", () => {
    for (const extra of [
      { lifecycleOwnerThreadId: "r" },
      { sourceThreadId: "r", visibility: "hidden" as const },
    ]) {
      const p = planSweep(
        [t("r"), t("c", { ...extra, latestAttentionAt: now })],
        { ...config, detachActiveDescendants: true },
        now,
      );
      expect(p.actions).toEqual([]);
      expect(p.blocked.length).toBeGreaterThan(0);
    }
  });
  it("detects cycles and dangling references without archiving", () => {
    expect(
      ids(
        planSweep(
          [t("a", { parentThreadId: "b" }), t("b", { parentThreadId: "a" })],
          config,
          now,
        ),
      ),
    ).toEqual([]);
    expect(
      ids(planSweep([t("a", { parentThreadId: "missing" })], config, now)),
    ).toEqual([]);
  });
  it("queued work and waiting interactions protect ancestors", () => {
    for (const extra of [{ busy: true }, { status: "pending" }])
      expect(
        ids(
          planSweep(
            [t("r"), t("c", { parentThreadId: "r", ...extra })],
            config,
            now,
          ),
        ),
      ).toEqual([]);
  });
});
describe("prune", () => {
  it("keeps target subtree, detaches target and active sibling, archives old ancestors and quiet branches", () => {
    const p = planPrune(
      [
        t("r"),
        t("mid", { parentThreadId: "r" }),
        t("keep", { parentThreadId: "mid", latestAttentionAt: now }),
        t("child", { parentThreadId: "keep" }),
        t("side", { parentThreadId: "r" }),
        t("active", { parentThreadId: "r", latestAttentionAt: now }),
      ],
      config,
      now,
      "keep",
    );
    expect(p.detachIds).toContain("keep");
    expect(p.actions[0].archiveIds).toEqual(["r", "mid", "side"]);
    expect(p.actions[0].detachIds).toContain("active");
  });
  it("explicit prune may handle pre-install backlog", () => {
    expect(
      planPrune(
        [t("r", { latestAttentionAt: 0 }), t("k", { parentThreadId: "r" })],
        config,
        now,
        "k",
      ).actions[0].rootId,
    ).toBe("r");
  });
  it("blocks immutable lifecycle owner without partial detach", () => {
    const p = planPrune(
      [t("r"), t("k", { parentThreadId: "r", lifecycleOwnerThreadId: "r" })],
      config,
      now,
      "k",
    );
    expect(p.actions).toEqual([]);
    expect(p.detachIds).toEqual([]);
    expect(p.blocked.join()).toContain("lifecycle");
  });
  it("preserves pinned old ancestor", () => {
    expect(
      planPrune(
        [t("r", { pinnedAt: 1 }), t("k", { parentThreadId: "r" })],
        config,
        now,
        "k",
      ).actions,
    ).toEqual([]);
  });
});
it.each([false, true])(
  "retains active subtrees across roots (detach=%s)",
  (detachActiveDescendants) => {
    const p = planSweep(
      [
        t("r1"),
        t("r2"),
        t("a", { parentThreadId: "r1", latestAttentionAt: now }),
        t("leaf", { parentThreadId: "a", lifecycleOwnerThreadId: "r2" }),
      ],
      { ...config, detachActiveDescendants },
      now,
    );
    expect(ids(p)).toEqual(detachActiveDescendants ? ["r1"] : []);
    expect(p.actions.flatMap((a) => a.archiveIds)).not.toContain("leaf");
  },
);
it("prune selects quiet side branches beneath a recent ancestor", () => {
  const p = planPrune(
    [
      t("r", { latestAttentionAt: now }),
      t("target", { parentThreadId: "r", latestAttentionAt: now }),
      t("side", { parentThreadId: "r" }),
    ],
    config,
    now,
    "target",
  );
  expect(p.detachIds).toEqual(["target"]);
  expect(ids(p)).toEqual(["side"]);
});
it("protects a kept branch across independent root ownership", () => {
  const p = planSweep(
    [
      t("r1"),
      t("r2"),
      t("kept", { parentThreadId: "r1", pinnedAt: 1 }),
      t("leaf", { parentThreadId: "kept", lifecycleOwnerThreadId: "r2" }),
    ],
    { ...config, detachActiveDescendants: true },
    now,
  );
  expect(ids(p)).toEqual([]);
});
it("prune never archives target descendants through a second ancestor owner", () => {
  const p = planPrune(
    [
      t("r2"),
      t("r1", { parentThreadId: "r2" }),
      t("target", { parentThreadId: "r1", latestAttentionAt: now }),
      t("leaf", { parentThreadId: "target", lifecycleOwnerThreadId: "r2" }),
    ],
    config,
    now,
    "target",
  );
  expect(ids(p)).toEqual(["r1"]);
  expect(p.actions.flatMap((a) => a.archiveIds)).not.toContain("leaf");
});
describe("permanent explicit titles", () => {
  it.each([
    "VPN - GLM",
    "GROWTH. AUTOMATION",
    "📌 ДЕНЬ",
    "DB",
    "BB_MIMO_V26_PRO_READY_20260922",
    "АВТОПИЛОТ",
    "A 1 Я 😀",
  ])("protects %s and its ancestors", (title) => {
    expect(
      ids(
        planSweep(
          [t("r"), t("c", { parentThreadId: "r", title })],
          config,
          now,
        ),
      ),
    ).toEqual([]);
  });
  it.each(["Handoff: VPN Kimi", "", "A", "Я", "12 - 😀", "vpn", "День", null])(
    "does not protect %j by title alone",
    (title) => {
      expect(ids(planSweep([t("r", { title })], config, now))).toEqual(["r"]);
    },
  );
  it("keeps legacy pin-prefix protection and counts overlapping reasons independently", () => {
    const rows = [
      t("a", { title: "📌 ДЕНЬ", pinnedAt: 1 }),
      t("b", { title: "DB" }),
      t("c", { title: "Handoff: VPN Kimi" }),
      t("archived", { title: "OLD", archived: true }),
    ];
    expect(
      countThreadExclusions(rows, { ...config, keepThreadIds: ["a", "c"] }),
    ).toEqual({ pinned: 1, pinPrefix: 1, uppercase: 2, keepThreadIds: 2 });
  });
});
