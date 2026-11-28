// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  providerIconIds,
  providerIconRegistry,
  type ProviderIconId,
} from "./icons.js";

const EXPECTED_IDS = [
  "acp-agy",
  "acp-opencode-kimi",
  "acp-oxi-cursor",
  "acp-oxi-devin-pool",
  "acp-opencode-go",
  "acp-opencode-zai",
  "acp-opencode-neuraldeep",
];

function markupFor(id: ProviderIconId, className?: string) {
  const Mark = providerIconRegistry[id];
  return renderToStaticMarkup(<Mark className={className} />);
}

function parseMarkup(markup: string) {
  const doc = new DOMParser().parseFromString(markup, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) throw new Error("mark rendered no root element");
  return { doc, root };
}

function styleMap(el: Element): Record<string, string> {
  const raw = el.getAttribute("style") ?? "";
  const map: Record<string, string> = {};
  for (const decl of raw.split(";")) {
    const idx = decl.indexOf(":");
    if (idx === -1) continue;
    const key = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (key) map[key] = value;
  }
  return map;
}

const MASK_URL_RE = /^url\("data:image\/svg\+xml,([^"]*)"\)$/;
const GEOMETRY_ATTRS = [
  "transform",
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-linecap",
  "stroke-linejoin",
  "d",
  "cx",
  "cy",
  "r",
] as const;

interface GoldenElement {
  tag: string;
  attrs: Record<string, string>;
}

/** Approved 0.1.0 shapes, kept verbatim as the independent shape contract:
 *  identical geometry, repainted opaque black for the alpha-mask. */
const GOLDEN_GEOMETRY: Record<ProviderIconId, GoldenElement[]> = {
  "acp-agy": [
    {
      tag: "path",
      attrs: {
        transform: "scale(1.5)",
        fill: "#000",
        d: "M14.1452 14.6818C14.9937 15.3182 16.2664 14.894 15.0997 13.7273C11.5998 10.3333 12.3421 1 7.99366 1C3.64518 1 4.3876 10.3333 0.887603 13.7273C-0.385123 15 0.993664 15.3182 1.84215 14.6818C5.13002 12.4545 4.9179 8.5303 7.99366 8.5303C11.0694 8.5303 10.8573 12.4545 14.1452 14.6818Z",
      },
    },
  ],
  "acp-opencode-kimi": [
    {
      tag: "path",
      attrs: {
        fill: "#000",
        d: "M19.514 7.342C19.711 7.862 19.814 8.413 19.816 8.969C19.816 12.494 15.998 14.697 12.946 12.934C11.529 12.116 10.657 10.605 10.657 8.969C10.657 5.646 14.085 3.431 17.115 4.793C15.26 3.373 12.99 2.607 10.655 2.612C4.772 2.614 0.005 7.381 0 13.265C0.002 19.148 4.772 23.918 10.655 23.92C16.538 23.916 21.306 19.147 21.31 13.265C21.312 11.155 20.687 9.095 19.514 7.342ZM14.841 4.666C14.841 8.191 18.657 10.395 21.709 8.632C23.127 7.814 24 6.302 24 4.666C24 1.14 20.184-1.061 17.13 0.699C15.714 1.519 14.841 3.03 14.841 4.666",
      },
    },
  ],
  "acp-oxi-cursor": [
    { tag: "g", attrs: { transform: "translate(1.2 1.2) scale(0.7)" } },
    {
      tag: "path",
      attrs: {
        fill: "#000",
        d: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
      },
    },
    { tag: "circle", attrs: { cx: "18.7", cy: "21.5", r: "1.7", fill: "#000" } },
    { tag: "circle", attrs: { cx: "21.5", cy: "18.7", r: "1.7", fill: "#000" } },
  ],
  "acp-oxi-devin-pool": [
    { tag: "g", attrs: { transform: "translate(2.235 1.2) scale(0.056)" } },
    {
      tag: "path",
      attrs: {
        fill: "#000",
        d: "M1.84577e-10 100.797V38.6224C1.88813e-05 35.8899 1.45777 33.365 3.82414 31.9988L57.6539 0.920185C60.0203 -0.446051 62.9358 -0.446051 65.3022 0.920185L119.132 31.9988C121.498 33.3651 122.956 35.8899 122.956 38.6224V70.375C123.192 80.9262 128.769 91.103 138.577 96.7655C148.384 102.428 159.986 102.169 169.242 97.0979L196.74 81.2217C199.107 79.8554 202.022 79.8554 204.388 81.2217L258.218 112.3C260.585 113.667 262.042 116.191 262.042 118.924V181.081C262.042 183.814 260.585 186.339 258.218 187.705L204.388 218.783C202.022 220.15 199.107 220.15 196.74 218.783L169.464 203.036C160.173 197.847 148.465 197.536 138.579 203.244C128.772 208.906 123.195 219.083 122.959 229.634V261.378C122.959 264.111 121.501 266.635 119.135 268.002L65.3048 299.08C62.9384 300.447 60.0229 300.447 57.6566 299.08L3.82673 268.002C1.46036 266.635 0.00260562 264.111 0.00260562 261.378V199.221C0.0026245 196.488 1.46038 193.963 3.82675 192.597L57.6565 161.519C60.0229 160.152 62.9384 160.152 65.3048 161.519L92.8656 177.431C102.11 182.467 113.679 182.711 123.463 177.062C133.349 171.355 138.934 161.06 139.086 150.419C138.85 139.868 133.274 128.601 123.466 122.938C113.658 117.276 102.056 117.534 92.8007 122.606L65.1758 138.645C62.7991 140.025 59.8649 140.024 57.4894 138.642L3.80216 107.407C1.44816 106.038 -1.88809e-05 103.52 1.84577e-10 100.797Z",
      },
    },
    { tag: "circle", attrs: { cx: "18.7", cy: "21.5", r: "1.7", fill: "#000" } },
    { tag: "circle", attrs: { cx: "21.5", cy: "18.7", r: "1.7", fill: "#000" } },
  ],
  "acp-opencode-go": [
    { tag: "g", attrs: { transform: "translate(4.35 3.0375) scale(0.04375)" } },
    {
      tag: "path",
      attrs: {
        fill: "#000",
        "fill-opacity": "0.45",
        d: "M180 240H60V120H180V240Z",
      },
    },
    {
      tag: "path",
      attrs: { fill: "#000", d: "M180 60H60V240H180V60ZM240 300H0V0H240V300Z" },
    },
    {
      tag: "path",
      attrs: {
        fill: "none",
        stroke: "#000",
        "stroke-width": "1.8",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        d: "M18.6 17.8 21.2 20.4 18.6 23",
      },
    },
  ],
  "acp-opencode-zai": [
    {
      tag: "path",
      attrs: {
        fill: "none",
        stroke: "#000",
        "stroke-width": "2.6",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        d: "M4.5 4.5h15L4.5 19.5h15",
      },
    },
  ],
  "acp-opencode-neuraldeep": [
    {
      tag: "path",
      attrs: {
        fill: "none",
        stroke: "#000",
        "stroke-width": "2.4",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        d: "M2.8 20.5V4l7.4 15.5V3.5",
      },
    },
    {
      tag: "path",
      attrs: {
        fill: "none",
        stroke: "#000",
        "stroke-width": "2.4",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        d: "M13.8 3.5h3.2a5 8.5 0 0 1 0 17h-3.2z",
      },
    },
  ],
};

function extractMaskSource(style: Record<string, string>): string {
  const url = style["mask-image"];
  expect(url).toBeDefined();
  const match = url ? MASK_URL_RE.exec(url) : null;
  expect(match, `mask-image must be an inline data URI, got ${url}`).not.toBeNull();
  return decodeURIComponent(match![1]);
}

function flattenGeometry(root: Element): GoldenElement[] {
  const out: GoldenElement[] = [];
  const walk = (el: Element) => {
    const attrs: Record<string, string> = {};
    for (const name of GEOMETRY_ATTRS) {
      const value = el.getAttribute(name);
      if (value !== null) attrs[name] = value;
    }
    out.push({ tag: el.tagName.toLowerCase(), attrs });
    for (const child of el.children) walk(child);
  };
  for (const child of root.children) walk(child);
  return out;
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

describe("rendered marks: native mask span", () => {
  it("render a span (never an outer svg) that adopts the host className", () => {
    for (const id of providerIconIds) {
      const { doc, root } = parseMarkup(markupFor(id, "size-full"));
      expect(root.tagName.toLowerCase(), `${id} must render a span`).toBe("span");
      expect(root.getAttribute("class"), `${id} host className`).toBe("size-full");
      expect(root.getAttribute("aria-hidden")).toBe("true");
      expect(
        doc.querySelectorAll("svg").length,
        `${id} must not render an outer naked svg`,
      ).toBe(0);
    }
  });

  it("paint through inline alpha-mask styles with pointer-events disabled", () => {
    for (const id of providerIconIds) {
      const { root } = parseMarkup(markupFor(id));
      const style = styleMap(root);
      expect(style["display"], `${id} display`).toBe("inline-block");
      expect(style["background-color"]?.toLowerCase(), `${id} color`).toBe(
        "currentcolor",
      );
      expect(style["pointer-events"], `${id} pointer-events`).toBe("none");
      for (const prop of ["mask-image", "-webkit-mask-image"]) {
        expect(style[prop], `${id} ${prop}`).toMatch(MASK_URL_RE);
        expect(
          style[prop]?.startsWith('url("data:image/svg+xml,'),
          `${id} ${prop} must be an inline data URI, not an external URL`,
        ).toBe(true);
      }
      expect(style["mask-image"], `${id} mask url must be shared`).toBe(
        style["-webkit-mask-image"],
      );
      for (const prop of ["mask-repeat", "-webkit-mask-repeat"]) {
        expect(style[prop], `${id} ${prop}`).toBe("no-repeat");
      }
      for (const prop of ["mask-position", "-webkit-mask-position"]) {
        expect(style[prop], `${id} ${prop}`).toBe("center");
      }
      for (const prop of ["mask-size", "-webkit-mask-size"]) {
        expect(style[prop], `${id} ${prop}`).toBe("contain");
      }
    }
  });
});

describe("decoded mask geometry", () => {
  it("is a well-formed static 24x24 svg with explicit intrinsic size", () => {
    for (const id of providerIconIds) {
      const { root } = parseMarkup(markupFor(id));
      const svgText = extractMaskSource(styleMap(root));
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      expect(
        doc.querySelector("parsererror"),
        `${id} mask svg must parse`,
      ).toBeNull();
      const svg = doc.documentElement;
      expect(svg.tagName.toLowerCase()).toBe("svg");
      expect(svg.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg.getAttribute("width")).toBe("24");
      expect(svg.getAttribute("height")).toBe("24");
    }
  });

  it("references no outside content and carries no scripts", () => {
    const forbiddenTags = [
      "script",
      "image",
      "foreignobject",
      "style",
      "iframe",
      "a",
      "use",
      "animate",
      "set",
    ];
    for (const id of providerIconIds) {
      const { root } = parseMarkup(markupFor(id));
      const svgText = extractMaskSource(styleMap(root));
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      for (const el of doc.querySelectorAll("*")) {
        expect(
          forbiddenTags.includes(el.tagName.toLowerCase()),
          `${id} forbids <${el.tagName}>`,
        ).toBe(false);
        expect(el.getAttribute("href"), `${id} must not link out`).toBeNull();
        expect(el.getAttribute("xlink:href"), `${id} must not link out`).toBeNull();
      }
    }
  });

  it("paints opaque black only, never currentColor", () => {
    for (const id of providerIconIds) {
      const { root } = parseMarkup(markupFor(id));
      const svgText = extractMaskSource(styleMap(root));
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      const painted = doc.querySelectorAll("[fill], [stroke]");
      expect(painted.length, `${id} must draw geometry`).toBeGreaterThan(0);
      for (const el of painted) {
        for (const paint of ["fill", "stroke"]) {
          const value = el.getAttribute(paint);
          expect(
            value === null ||
              value === "#000" ||
              value === "black" ||
              value === "none",
            `${id}: unexpected ${paint} ${value}`,
          ).toBe(true);
          expect(value, `${id}: ${paint} must not be currentColor`).not.toBe(
            "currentColor",
          );
        }
      }
    }
  });

  it("preserves the approved 0.1.0 shape for every mark", () => {
    for (const id of providerIconIds) {
      const { root } = parseMarkup(markupFor(id));
      const svgText = extractMaskSource(styleMap(root));
      const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
      expect(flattenGeometry(doc.documentElement), `${id} geometry drifted`).toEqual(
        GOLDEN_GEOMETRY[id],
      );
    }
  });

  it("draw distinct geometry for every provider id", () => {
    const shapes = new Map<string, string>();
    for (const id of providerIconIds) {
      const { root } = parseMarkup(markupFor(id, "same-class"));
      const svgText = extractMaskSource(styleMap(root));
      shapes.set(id, svgText);
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
