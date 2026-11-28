#!/usr/bin/env node
/**
 * Tap regression for the live-DOM model-picker replica preview.
 *
 * Builds `preview/dist` (the real registration + the real mark components
 * behind the host's live drawer markup) and drives Chromium in two contexts:
 *
 *   - desktop: 1440x900, fine pointer, mouse clicks;
 *   - mobile:  390x844 (iPhone-class descriptor), touch + `pointer:coarse`,
 *              real touchscreen taps.
 *   - desktop-coarse probe (structure only): 1440x900 with touch emulation,
 *              proving the coarse geometry needs BOTH `max-md` AND
 *              `pointer:coarse`, never a plain coarse override.
 *
 * Environment facts are recorded and asserted per context: actual
 * `innerWidth`/`clientWidth` (never a widened 980px layout), actual
 * `matchMedia("(pointer: coarse)")` and the exact
 * `(max-width: 767.98px) and (pointer: coarse)` branch, wrapper computed
 * size (16px fine / 20px coarse), button computed height (28px h-7 / 36px
 * h-9) and the button's PRE-FLEX-SHRINK width (24px w-6 / 36px w-9),
 * measured on an off-screen clone outside the flex row. The drawer's
 * inline `width/min-width/max-width` override and the tabs row's
 * gap/padding/overflow are checked against the live markup.
 *
 * For every one of the eleven provider buttons it verifies, at the button
 * center and four interior edge points, that `document.elementFromPoint`
 * resolves to that exact button (never to an overlapping tab or the mark)
 * and that a real tap selects that button's provider id. Registered marks
 * must keep `pointer-events: none` and both computed mask images.
 *
 * Requires an existing Playwright installation; pass it via PLAYWRIGHT_MODULE
 * (path to a playwright package entry, e.g. .../node_modules/playwright/index.mjs).
 * Nothing is downloaded or installed by this script. Write a JSON receipt with
 * --receipt <path>. Serve an already built preview with PREVIEW_URL.
 *
 * Usage, from the plugin directory:
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *     node preview/tap-regression.mjs [--receipt file.json]
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { extname } from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = new URL("..", import.meta.url).pathname;
const DIST_DIR = new URL("dist/", import.meta.url).pathname;

const REGISTERED_IDS = [
  "acp-agy",
  "acp-opencode-kimi",
  "acp-oxi-cursor",
  "acp-oxi-devin-pool",
  "acp-opencode-go",
  "acp-opencode-zai",
  "acp-opencode-neuraldeep",
];
const BUILTIN_IDS = ["codex", "claude-code", "acp-cursor"];
const EXPECTED_BUTTONS = 11;

const args = process.argv.slice(2);
const receiptIndex = args.indexOf("--receipt");
const receiptPath = receiptIndex !== -1 ? args[receiptIndex + 1] : null;

// Resolve Playwright from the plugin's own devDependencies by default
// (pinned 1.58.2, matching the host's prepared browser cache). The
// PLAYWRIGHT_MODULE override points at an existing external installation
// when the devDependency is not installed; this script never downloads or
// installs anything itself.
let playwrightSource = "playwright (devDependency)";
let chromium;
let devices;
try {
  ({ chromium, devices } = await import("playwright"));
} catch {
  const playwrightModule =
    process.env.PLAYWRIGHT_MODULE ?? process.env.PLAYWRIGHT_PATH;
  if (!playwrightModule) {
    console.error(
      "Playwright is not installed as a devDependency and PLAYWRIGHT_MODULE is unset " +
        "(point it at an existing playwright package entry; no downloads are performed).",
    );
    process.exit(2);
  }
  ({ chromium, devices } = await import(playwrightModule));
  playwrightSource = playwrightModule;
}

const receipt = {
  startedAt: new Date().toISOString(),
  playwrightSource,
  url: process.env.PREVIEW_URL ?? null,
  contexts: [],
  failures: [],
  checks: 0,
};

function fail(context, phase, detail) {
  receipt.failures.push({ context, phase, ...detail });
}

async function serveDist() {
  const server = createServer(async (req, res) => {
    try {
      const path = req.url === "/" || req.url === "/index.html" ? "/index.html" : req.url;
      const body = await readFile(DIST_DIR + "/" + path.slice(1));
      res.writeHead(200, {
        "content-type":
          extname(path) === ".js" ? "text/javascript" : "text/html; charset=utf-8",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

async function runContext(browser, name, options, tapKind, structureOnly = false) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const info = { name, tapKind, structureOnly, environment: {}, buttonCount: 0, taps: 0 };
  receipt.contexts.push(info);
  await page.goto(receipt.url, { waitUntil: "load" });
  await page.waitForSelector('[data-fixture="provider-drawer"]', {
    state: "attached",
  });
  await page.waitForTimeout(150);

  // 1. Environment: real viewport, real pointer media, exact target branch.
  info.environment = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    coarse: matchMedia("(pointer:coarse)").matches,
    anyCoarse: matchMedia("(any-pointer:coarse)").matches,
    fine: matchMedia("(pointer:fine)").matches,
    coarseBranch: matchMedia("(max-width: 767.98px) and (pointer:coarse)").matches,
    hasTouch: "ontouchstart" in window,
  }));
  const env = info.environment;
  receipt.checks += 4;
  const expectedWidth = options.viewport.width;
  // Coarse pointer is expected in the mobile context and in the
  // desktop-coarse probe (touch emulation); the max-md geometry branch is
  // expected ONLY in the mobile context.
  const expectedCoarse = name === "mobile" || name === "desktop-coarse-probe";
  const expectedBranch = name === "mobile";
  if (env.innerWidth !== expectedWidth) {
    fail(name, "environment", {
      expected: `innerWidth ${expectedWidth}`,
      actual: env.innerWidth,
    });
  }
  if (env.clientWidth !== expectedWidth) {
    fail(name, "environment", {
      expected: `clientWidth ${expectedWidth} (no 980px layout viewport)`,
      actual: env.clientWidth,
    });
  }
  if (env.coarse !== expectedCoarse) {
    fail(name, "environment", {
      expected: `pointer:coarse ${expectedCoarse}`,
      actual: env.coarse,
    });
  }
  if (env.coarseBranch !== expectedBranch) {
    fail(name, "media-branch", {
      expected: `(max-width:767.98px) and (pointer:coarse) → ${expectedBranch}`,
      actual: env.coarseBranch,
    });
  }

  // 2. Structure: live markup, host geometry, mark hit-safety.
  const structure = await page.evaluate(
    ({ registeredIds, builtinIds, expectedButtons }) => {
      const drawer = document.querySelector('[data-fixture="provider-drawer"]');
      const row = document.querySelector('[data-fixture="provider-row"]');
      const buttons = [
        ...document.querySelectorAll("button[data-provider-id]"),
      ];
      const drawerStyle = drawer ? getComputedStyle(drawer) : null;
      const rowStyle = row ? getComputedStyle(row) : null;

      const marks = [];
      const preShrink = [];
      for (const btn of buttons) {
        const wrap = btn.querySelector('[data-fixture="icon-wrap"]');
        const mark = wrap?.firstElementChild;
        if (mark) {
          const computed = getComputedStyle(mark);
          const entry = {
            providerId: btn.dataset.providerId,
            kind: registeredIds.includes(btn.dataset.providerId)
              ? "registered"
              : builtinIds.includes(btn.dataset.providerId)
                ? "builtin"
                : "fallback",
            tag: mark.tagName.toLowerCase(),
            specifiedDisplay: mark.style.display,
            computedDisplay: computed.display,
            pointerEvents: computed.pointerEvents,
            maskImage: computed.getPropertyValue("mask-image"),
            webkitMaskImage: computed.getPropertyValue("-webkit-mask-image"),
            attrWidth: mark.getAttribute("width"),
            attrHeight: mark.getAttribute("height"),
          };
          marks.push(entry);
        }
        // Pre-flex-shrink button geometry: measure an off-screen clone that
        // keeps every class but leaves the constrained flex row.
        const clone = btn.cloneNode(true);
        clone.style.position = "fixed";
        clone.style.left = "-9999px";
        document.body.append(clone);
        const cloneRect = clone.getBoundingClientRect();
        clone.remove();
        const wrapRect = wrap?.getBoundingClientRect();
        const rect = btn.getBoundingClientRect();
        preShrink.push({
          providerId: btn.dataset.providerId,
          button: {
            w: rect.width,
            h: rect.height,
            left: rect.left,
            right: rect.right,
          },
          preShrinkW: cloneRect.width,
          preShrinkH: cloneRect.height,
          wrap: { w: wrapRect?.width ?? null, h: wrapRect?.height ?? null },
        });
      }
      return {
        hasDrawer: Boolean(drawer),
        drawerMinWidth: drawerStyle?.minWidth ?? null,
        drawerMaxWidth: drawerStyle?.maxWidth ?? null,
        rowGap: rowStyle?.gap ?? null,
        rowOverflowX: rowStyle?.overflowX ?? null,
        rowPaddingLeft: rowStyle?.paddingLeft ?? null,
        buttonCount: buttons.length,
        marks,
        preShrink,
      };
    },
    { registeredIds: REGISTERED_IDS, builtinIds: BUILTIN_IDS, expectedButtons: EXPECTED_BUTTONS },
  );
  info.buttonCount = structure.buttonCount;
  receipt.checks += 2;
  if (!structure.hasDrawer) fail(name, "structure", { expected: "drawer fixture" });
  if (structure.buttonCount !== EXPECTED_BUTTONS) {
    fail(name, "structure", {
      expected: `${EXPECTED_BUTTONS} provider tabs`,
      actual: structure.buttonCount,
    });
  }

  // Live-DOM contract: drawer inline override and tabs row chrome.
  receipt.checks += 5;
  if (structure.drawerMinWidth !== "auto") {
    fail(name, "drawer-style", { expected: "min-width:auto", actual: structure.drawerMinWidth });
  }
  if (structure.drawerMaxWidth !== "none") {
    fail(name, "drawer-style", { expected: "max-width:none", actual: structure.drawerMaxWidth });
  }
  if (structure.rowGap !== "2px") {
    fail(name, "row-style", { expected: "gap-0.5 → 2px", actual: structure.rowGap });
  }
  if (structure.rowOverflowX !== "visible") {
    fail(name, "row-style", { expected: "overflow-x:visible", actual: structure.rowOverflowX });
  }
  if (structure.rowPaddingLeft !== "10px") {
    fail(name, "row-style", { expected: "px-2.5 → 10px", actual: structure.rowPaddingLeft });
  }

  const expectedButtonHeight = expectedBranch ? 36 : 28;
  const expectedWrap = expectedBranch ? 20 : 16;
  const expectedPreShrinkW = expectedBranch ? 36 : 24;
  for (const size of structure.preShrink) {
    receipt.checks += 4;
    if (Math.round(size.button.h) !== expectedButtonHeight) {
      fail(name, "button-geometry", {
        providerId: size.providerId,
        expected: `computed height ${expectedButtonHeight}px (h-${expectedCoarse ? 9 : 7})`,
        actual: size.button.h,
      });
    }
    if (Math.round(size.preShrinkW) !== expectedPreShrinkW) {
      fail(name, "button-geometry", {
        providerId: size.providerId,
        expected: `pre-flex-shrink width ${expectedPreShrinkW}px (w-${expectedCoarse ? 9 : 6})`,
        actual: size.preShrinkW,
      });
    }
    if (Math.round(size.preShrinkH) !== expectedButtonHeight) {
      fail(name, "button-geometry", {
        providerId: size.providerId,
        expected: `pre-flex-shrink height ${expectedButtonHeight}px`,
        actual: size.preShrinkH,
      });
    }
    const wrapW = Math.round(size.wrap.w ?? -1);
    const wrapH = Math.round(size.wrap.h ?? -1);
    if (wrapW !== expectedWrap || wrapH !== expectedWrap) {
      fail(name, "wrapper-size", {
        providerId: size.providerId,
        expected: `icon wrapper ${expectedWrap}x${expectedWrap}px computed`,
        actual: `${size.wrap.w}x${size.wrap.h}`,
      });
    }
    if (!structureOnly && (size.button.left < 0 || size.button.right > env.innerWidth)) {
      fail(name, "button-visibility", {
        providerId: size.providerId,
        detail: `button spans ${size.button.left}..${size.button.right} outside viewport 0..${env.innerWidth}`,
      });
    }
  }

  // Mark contract per kind: registered (ours), builtin (bg-current mask
  // span), fallback (Lucide svg with intrinsic width/height 24).
  for (const mark of structure.marks) {
    if (mark.kind === "registered") {
      receipt.checks += 5;
      if (mark.tag !== "span") {
        fail(name, "mark-shape", {
          providerId: mark.providerId,
          expected: "our mask span",
          actual: mark.tag,
        });
      }
      if (mark.pointerEvents !== "none") {
        fail(name, "mark-pointer-events", {
          providerId: mark.providerId,
          expected: "none",
          actual: mark.pointerEvents,
        });
      }
      if (mark.specifiedDisplay !== "inline-block") {
        fail(name, "mark-display", {
          providerId: mark.providerId,
          expected: "inline-block (inline style)",
          actual: mark.specifiedDisplay,
        });
      }
      // Flex items are blockified by CSS: computed display may legitimately
      // read "block" inside the inline-flex host wrapper.
      if (!["inline-block", "block"].includes(mark.computedDisplay)) {
        fail(name, "mark-display", {
          providerId: mark.providerId,
          expected: "inline-block or flex-blockified block",
          actual: mark.computedDisplay,
        });
      }
      for (const prop of ["maskImage", "webkitMaskImage"]) {
        if (!mark[prop].includes('url("data:image/svg+xml,')) {
          fail(name, "mark-mask", {
            providerId: mark.providerId,
            prop,
            expected: "inline data-URI mask",
            actual: mark[prop].slice(0, 80),
          });
        }
      }
    } else if (mark.kind === "builtin") {
      receipt.checks += 2;
      if (mark.tag !== "span") {
        fail(name, "builtin-mark", {
          providerId: mark.providerId,
          expected: "builtin bg-current mask span",
          actual: mark.tag,
        });
      }
      if (!mark.maskImage.includes('url("data:image/svg+xml,')) {
        fail(name, "builtin-mark", {
          providerId: mark.providerId,
          expected: "inline data-URI mask",
          actual: mark.maskImage.slice(0, 80),
        });
      }
    } else {
      receipt.checks += 2;
      if (mark.tag !== "svg") {
        fail(name, "fallback-glyph", {
          providerId: mark.providerId,
          expected: "Lucide svg",
          actual: mark.tag,
        });
      }
      if (mark.attrWidth !== "24" || mark.attrHeight !== "24") {
        fail(name, "fallback-glyph", {
          providerId: mark.providerId,
          expected: "intrinsic width/height 24",
          actual: `${mark.attrWidth}x${mark.attrHeight}`,
        });
      }
    }
  }

  // 3. Hit-testing and real taps: center and four interior edge points.
  if (!structureOnly) {
    const buttons = await page.$$("button[data-provider-id]");
    for (const button of buttons) {
      const providerId = await button.getAttribute("data-provider-id");
      await button.scrollIntoViewIfNeeded();
      const box = await button.boundingBox();
      if (!box) {
        fail(name, "tap", { providerId, detail: "button has no bounding box" });
        continue;
      }
      const points = [
        [box.x + box.width / 2, box.y + box.height / 2],
        [box.x + box.width * 0.25, box.y + box.height / 2],
        [box.x + box.width * 0.75, box.y + box.height / 2],
        [box.x + box.width / 2, box.y + box.height * 0.25],
        [box.x + box.width / 2, box.y + box.height * 0.75],
      ];
      for (const [px, py] of points) {
        receipt.checks += 2;
        const hit = await page.evaluate(
          ([x, y, expectedId]) => {
            const el = document.elementFromPoint(x, y);
            const btn = el?.closest?.("button[data-provider-id]");
            return {
              resolved: btn?.dataset.providerId ?? null,
              expected: expectedId,
            };
          },
          [px, py, providerId],
        );
        if (hit.resolved !== providerId) {
          fail(name, "elementFromPoint", {
            providerId,
            point: [Math.round(px), Math.round(py)],
            expected: providerId,
            actual: hit.resolved,
          });
        }
        try {
          if (tapKind === "touch") await page.touchscreen.tap(px, py);
          else await page.mouse.click(px, py);
          info.taps += 1;
          await page.waitForTimeout(40);
          const selected = await page.evaluate(() =>
            document
              .querySelector("[data-selected-id]")
              ?.getAttribute("data-selected-id"),
          );
          if (selected !== providerId) {
            fail(name, "tap-selection", {
              providerId,
              point: [Math.round(px), Math.round(py)],
              expected: providerId,
              actual: selected,
            });
          }
        } catch (error) {
          fail(name, "tap", {
            providerId,
            point: [Math.round(px), Math.round(py)],
            detail: String(error).split("\n")[0],
          });
        }
      }
    }
  }
  await context.close();
  return info;
}

// Build the preview unless an external PREVIEW_URL is supplied.
if (!receipt.url) {
  execFileSync(process.execPath, ["preview/build.mjs"], {
    cwd: PLUGIN_DIR,
    stdio: "inherit",
  });
  const served = await serveDist();
  receipt.url = served.url;
  var server = served.server;
}

const browser = await chromium.launch();
try {
  await runContext(
    browser,
    "desktop",
    { viewport: { width: 1440, height: 900 }, hasTouch: false, isMobile: false },
    "mouse",
  );
  await runContext(
    browser,
    "mobile",
    { ...devices["iPhone 13"] },
    "touch",
  );
  // Media fidelity probe: coarse pointer at a wide viewport must NOT enter
  // the max-md branch — wrapper stays 16px, tab stays h-7 w-6.
  await runContext(
    browser,
    "desktop-coarse-probe",
    { viewport: { width: 1440, height: 900 }, hasTouch: true, isMobile: false },
    "none",
    true,
  );
} finally {
  await browser.close();
  await server?.close();
}

receipt.finishedAt = new Date().toISOString();
receipt.passed = receipt.failures.length === 0;
const summary = {
  url: receipt.url,
  contexts: receipt.contexts.map((c) => ({
    name: c.name,
    tapKind: c.tapKind,
    structureOnly: c.structureOnly ?? false,
    innerWidth: c.environment.innerWidth,
    clientWidth: c.environment.clientWidth,
    coarse: c.environment.coarse,
    coarseBranch: c.environment.coarseBranch,
    buttons: c.buttonCount,
    taps: c.taps,
  })),
  checks: receipt.checks,
  failures: receipt.failures.length,
  passed: receipt.passed,
};
console.log(JSON.stringify(summary, null, 2));
if (receiptPath) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
}
process.exit(receipt.passed ? 0 : 1);
