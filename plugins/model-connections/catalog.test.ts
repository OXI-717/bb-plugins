import { describe, it, expect } from "vitest";
import { classifyConnections, type CatalogProvider } from "./catalog";

const provider = (id: string, name = id): CatalogProvider => ({
  id,
  name,
  available: true,
  logoUrl: null,
  icon: "Toolbox",
});
const pool = {
  routing: {
    codex: true,
    claude: true,
    cursor: true,
    devin: true,
    kimi: true,
    zai: true,
    "opencode-go": true,
  },
  accounts: [
    { provider: "codex", enabled: true },
    { provider: "cursor", enabled: true },
  ],
};
describe("connection grouping", () => {
  it("uses routing, not provider name, and removes exact duplicate IDs", () => {
    const rows = classifyConnections(
      [
        provider("codex"),
        provider("codex"),
        provider("acp-cursor", "Cursor"),
        provider("acp-oxi-cursor", "Cursor"),
      ],
      new Map([["acp-cursor", "ready"]]),
      pool,
      [],
      null,
    );
    expect(rows.map((x) => [x.id, x.group])).toEqual([
      ["codex", "pool"],
      ["acp-cursor", "local"],
      ["acp-oxi-cursor", "pool"],
    ]);
  });
  it("does not offer confirmed missing Pi or unknown local auth as usable", () => {
    const rows = classifyConnections(
      [provider("pi"), provider("acp-grok")],
      new Map([["pi", "not_installed"]]),
      pool,
      [],
      null,
    );
    expect(rows.every((x) => !x.selectable)).toBe(true);
    expect(rows[0].detail).toBe("Не установлен");
  });
  it("does not call an unknown pooled route local when Pooler is unavailable", () => {
    const [row] = classifyConnections(
      [provider("codex")],
      new Map([["codex", "ready"]]),
      null,
      [],
      null,
    );
    expect(row.group).toBe("pool");
    expect(row.selectable).toBe(false);
  });
  it("recognizes routing off and current-thread bypass without rewriting policy", () => {
    const rows = classifyConnections(
      [provider("codex"), provider("claude-code")],
      new Map([
        ["codex", "ready"],
        ["claude-code", "ready"],
      ]),
      { ...pool, routing: { ...pool.routing, claude: false } },
      [],
      "codex",
    );
    expect(rows.every((x) => x.group === "local" && x.selectable)).toBe(true);
  });
  it("keeps a dedicated pool wrapper unavailable when routing is off", () => {
    const [row] = classifyConnections(
      [provider("acp-oxi-cursor")],
      new Map([["acp-oxi-cursor", "ready"]]),
      { ...pool, routing: { ...pool.routing, cursor: false } },
      [],
      null,
    );
    expect(row.group).toBe("pool");
    expect(row.selectable).toBe(false);
  });
  it("hides only in this chooser and does not hide the current selection implicitly", () => {
    const [row] = classifyConnections(
      [provider("codex")],
      new Map(),
      pool,
      ["codex"],
      null,
    );
    expect(row.hidden).toBe(true);
    expect(row.selectable).toBe(true);
  });
  it("does not equate configured accounts with a successful network probe", () => {
    const [row] = classifyConnections(
      [provider("codex")],
      new Map(),
      pool,
      [],
      null,
    );
    expect(row.detail).toBe("Через пул");
    expect(row.selectable).toBe(true);
  });
  it("does not leak account identities into a catalog row", () => {
    const rows = classifyConnections(
      [provider("codex")],
      new Map(),
      pool,
      [],
      null,
    );
    expect(JSON.stringify(rows)).not.toMatch(/email|accountId|token/);
  });
});
