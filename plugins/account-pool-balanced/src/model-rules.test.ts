import { describe, expect, it } from "vitest";
import { modelRulesSchema, resolveModelRules } from "./model-rules.js";

const accounts = (rules: Record<string, Array<{ pattern: string; mode: "pin" | "allow" | "deny"; fallback?: boolean }>>) =>
  Object.entries(rules).map(([id, modelRules]) => ({ id, modelRules }));

describe("model rules", () => {
  it("leaves accounts without rules alone", () => {
    expect(resolveModelRules("gemini-4-neon", [{ id: "a" }, { id: "b", modelRules: [] }])).toEqual({ excluded: new Map(), pinned: [], fallback: false });
  });

  it("lets an exact id beat a prefix and a longer prefix beat a shorter one", () => {
    const result = resolveModelRules("gemini-4-neon-high", accounts({
      a: [{ pattern: "gemini-4-*", mode: "deny" }, { pattern: "gemini-4-neon-high", mode: "pin" }],
      b: [{ pattern: "gemini-*", mode: "deny" }, { pattern: "gemini-4-neon*", mode: "pin" }],
    }));
    expect(result.pinned).toEqual(["a", "b"]);
    expect(result.excluded.size).toBe(0);
  });

  it("makes deny win over pin at the same specificity and keeps an allow list closed", () => {
    const result = resolveModelRules("m-1", accounts({
      a: [{ pattern: "m-1", mode: "pin" }, { pattern: "m-1", mode: "deny" }],
      b: [{ pattern: "other", mode: "allow" }],
      c: [{ pattern: "m-*", mode: "allow" }],
    }));
    expect(result.excluded.get("a")).toBe("model-rule-denied");
    expect(result.excluded.get("b")).toBe("model-rule-not-allowed");
    expect(result.excluded.has("c")).toBe(false);
  });

  it("keeps the other accounts off a pinned model and reports the fallback choice", () => {
    const strict = resolveModelRules("m-1", accounts({ a: [{ pattern: "m-1", mode: "pin" }], b: [] }));
    expect(strict).toMatchObject({ pinned: ["a"], fallback: false });
    expect(strict.excluded.get("b")).toBe("model-rule-pinned-elsewhere");
    expect(resolveModelRules("m-1", accounts({ a: [{ pattern: "m-1", mode: "pin", fallback: true }], b: [] })).fallback).toBe(true);
  });

  it("accepts only plain ids, one trailing star and distinct rules", () => {
    expect(modelRulesSchema.safeParse([{ pattern: "gemini-4-hydrogen*", mode: "pin" }]).success).toBe(true);
    for (const bad of ["*", "a*b", "a b", "../x", ""]) expect(modelRulesSchema.safeParse([{ pattern: bad, mode: "pin" }]).success).toBe(false);
    expect(modelRulesSchema.safeParse([{ pattern: "a", mode: "pin" }, { pattern: "a", mode: "pin" }]).success).toBe(false);
  });
});
