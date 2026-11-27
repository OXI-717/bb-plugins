// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  providerIconIds,
  providerIconRegistry,
  type ProviderIconId,
} from "./icons.js";

afterEach(cleanup);

const EXPECTED_IDS = [
  "acp-agy",
  "acp-opencode-kimi",
  "acp-oxi-cursor",
  "acp-oxi-devin-pool",
  "acp-opencode-go",
  "acp-opencode-zai",
  "acp-opencode-neuraldeep",
];

function renderIcon(id: ProviderIconId, className?: string) {
  const Mark = providerIconRegistry[id];
  return render(<Mark className={className} />);
}

describe("provider icon registry", () => {
  it("contains exactly the seven public-safe provider ids", () => {
    expect(providerIconIds).toHaveLength(EXPECTED_IDS.length);
    expect([...providerIconIds].sort()).toEqual([...EXPECTED_IDS].sort());
  });

  it("maps every id to a distinct component", () => {
    const components = providerIconIds.map((id) => providerIconRegistry[id]);
    for (const component of components) {
      expect(typeof component).toBe("function");
    }
    expect(new Set(components).size).toBe(providerIconIds.length);
  });
});

describe("rendered marks", () => {
  it("render a static 24x24 svg that adopts the host className", () => {
    for (const id of providerIconIds) {
      const { container } = renderIcon(id, "host-size-16");
      const svg = container.querySelector("svg");
      expect(svg, `${id} must render an svg`).not.toBeNull();
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg?.getAttribute("class")).toBe("host-size-16");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("focusable")).toBe("false");
    }
  });

  it("paint only with currentColor and reference no outside content", () => {
    const forbiddenTags = ["script", "image", "foreignobject", "style", "iframe", "a"];
    for (const id of providerIconIds) {
      const { container } = renderIcon(id);
      const elements = container.querySelectorAll("*");
      expect(elements.length, `${id} must draw geometry`).toBeGreaterThan(1);
      for (const element of elements) {
        const fill = element.getAttribute("fill");
        const stroke = element.getAttribute("stroke");
        expect(
          fill === null || fill === "currentColor" || fill === "none",
          `${id}: unexpected fill ${fill}`,
        ).toBe(true);
        expect(
          stroke === null || stroke === "currentColor" || stroke === "none",
          `${id}: unexpected stroke ${stroke}`,
        ).toBe(true);
        expect(element.getAttribute("href"), `${id} must not link out`).toBeNull();
        expect(element.getAttribute("xlink:href"), `${id} must not link out`).toBeNull();
        expect(forbiddenTags).not.toContain(element.tagName.toLowerCase());
      }
    }
  });

  it("draw distinct geometry for every provider id", () => {
    const shapes = new Map<string, string>();
    for (const id of providerIconIds) {
      const { container } = renderIcon(id, "same-class");
      shapes.set(id, container.innerHTML);
    }
    expect(new Set(shapes.values()).size).toBe(providerIconIds.length);
  });
});

describe("static safety: no IO, timers, network or storage", () => {
  const FORBIDDEN_TOKENS = [
    "useEffect",
    "useSyncExternalStore",
    "fetch(",
    "setTimeout",
    "setInterval",
    "setImmediate",
    "requestAnimationFrame",
    "EventSource",
    "XMLHttpRequest",
    "WebSocket",
    "localStorage",
    "sessionStorage",
    "indexedDB",
    "addEventListener",
    "navigator.",
    "window.",
    "document.",
    "process.",
    "Math.random",
    "new Date",
    "href=",
    "xlink",
    "<script",
    "<image",
    "<foreignObject",
    "<style",
  ];

  for (const file of ["icons.tsx", "app.tsx"]) {
    it(`${file} stays free of IO, timers, network and storage`, () => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const token of FORBIDDEN_TOKENS) {
        expect(source.includes(token), `${file} must not contain ${token}`).toBe(false);
      }
    });
  }
});
