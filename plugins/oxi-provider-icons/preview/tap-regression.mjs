#!/usr/bin/env node
/**
 * Tap regression for the native model-picker replica preview.
 *
 * Builds `preview/dist` (the real registration + the real mark components
 * behind the faithful host drawer replica), serves it on a free localhost
 * port and drives Chromium in two contexts:
 *
 *   - desktop: 1440x900, fine pointer, mouse clicks;
 *   - mobile:  390x844 (iPhone-class descriptor), touch + `pointer:coarse`,
 *              real touchscreen taps.
 *
 * For every one of the eleven provider buttons it verifies, at the button
 * center and four interior points, that `document.elementFromPoint` resolves
 * to that exact button (never to an overlapping row or the mark itself) and
 * that a real tap selects that button's provider id. It also checks the
 * coarse-pointer geometry (h-9 w-9 buttons, 20 px min-w-max icon wrappers)
 * and that every rendered registered mark keeps `pointer-events: none` and
 * both computed mask images.
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
const EXPECTED_BUTTONS = 11;

const args = process.argv.slice(2);
const receiptIndex = args.indexOf("--receipt");
const receiptPath = receiptIndex !== -1 ? args[receiptIndex + 1] : null;

const playwrightModule =
  process.env.PLAYWRIGHT_MODULE ?? process.env.PLAYWRIGHT_PATH;
if (!playwrightModule) {
  console.error(
    "PLAYWRIGHT_MODULE must point to an installed playwright package entry (no downloads performed).",
  );
  process.exit(2);
}
const { chromium, devices } = await import(playwrightModule);

const receipt = {
  startedAt: new Date().toISOString(),
  playwrightModule,
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
      const body = await readFile(DIST_DIR + path.slice(1));
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

async function runContext(browser, name, options, tapKind) {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const info = { name, tapKind, environment: {}, buttonCount: 0, taps: 0 };
  receipt.contexts.push(info);
  await page.goto(receipt.url, { waitUntil: "load" });
  await page.waitForSelector('[data-fixture="provider-drawer"]', {
    state: "attached",
  });
  await page.waitForTimeout(150);

  // 1. Environment: real viewport and pointer media, never a widened layout.
  info.environment = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    coarse: matchMedia("(pointer:coarse)").matches,
    anyCoarse: matchMedia("(any-pointer:coarse)").matches,
    fine: matchMedia("(pointer:fine)").matches,
    hasTouch: "ontouchstart" in window,
  }));
  receipt.checks += 4;
  const expectedWidth = options.viewport.width;
  const expectedCoarse = name === "mobile";
  if (info.environment.innerWidth !== expectedWidth) {
    fail(name, "environment", {
      expected: `innerWidth ${expectedWidth}`,
      actual: info.environment.innerWidth,
    });
  }
  if (info.environment.clientWidth !== expectedWidth) {
    fail(name, "environment", {
      expected: `clientWidth ${expectedWidth} (no 980px layout viewport)`,
      actual: info.environment.clientWidth,
    });
  }
  if (info.environment.coarse !== expectedCoarse) {
    fail(name, "environment", {
      expected: `pointer:coarse ${expectedCoarse}`,
      actual: info.environment.coarse,
    });
  }
  if (info.environment.anyCoarse !== expectedCoarse) {
    fail(name, "environment", {
      expected: `any-pointer:coarse ${expectedCoarse}`,
      actual: info.environment.anyCoarse,
    });
  }

  // 2. Structure: eleven buttons, faithful host geometry, mark hit-safety.
  const structure = await page.evaluate(
    ({ registeredIds, expectedButtons }) => {
      const drawer = document.querySelector('[data-fixture="provider-drawer"]');
      const buttons = [
        ...document.querySelectorAll("button[data-provider-id]"),
      ];
      const marks = [];
      for (const btn of buttons) {
        if (!registeredIds.includes(btn.dataset.providerId)) continue;
        const wrap = btn.querySelector('[data-fixture="icon-wrap"]');
        const mark = wrap?.firstElementChild;
        if (mark) {
          const computed = getComputedStyle(mark);
          marks.push({
            providerId: btn.dataset.providerId,
            pointerEvents: computed.pointerEvents,
            specifiedDisplay: mark.style.display,
            computedDisplay: computed.display,
            maskImage: computed.getPropertyValue("mask-image"),
            webkitMaskImage: computed.getPropertyValue("-webkit-mask-image"),
          });
        }
      }
      const sizes = buttons.map((btn) => {
        const wrap = btn.querySelector('[data-fixture="icon-wrap"]');
        const wrapRect = wrap?.getBoundingClientRect();
        const rect = btn.getBoundingClientRect();
        return {
          providerId: btn.dataset.providerId,
          button: { w: rect.width, h: rect.height, left: rect.left, right: rect.right },
          wrap: { w: wrapRect?.width ?? null, h: wrapRect?.height ?? null },
        };
      });
      return {
        hasDrawer: Boolean(drawer),
        buttonCount: buttons.length,
        marks,
        sizes,
      };
    },
    { registeredIds: REGISTERED_IDS, expectedButtons: EXPECTED_BUTTONS },
  );
  info.buttonCount = structure.buttonCount;
  receipt.checks += 2;
  if (!structure.hasDrawer) fail(name, "structure", { expected: "drawer fixture" });
  if (structure.buttonCount !== EXPECTED_BUTTONS) {
    fail(name, "structure", {
      expected: `${EXPECTED_BUTTONS} provider buttons`,
      actual: structure.buttonCount,
    });
  }

  const expectedButtonHeight = expectedCoarse ? 36 : 28;
  const expectedWrap = expectedCoarse ? 20 : 16;
  for (const size of structure.sizes) {
    receipt.checks += 3;
    if (Math.round(size.button.h) !== expectedButtonHeight) {
      fail(name, "button-size", {
        providerId: size.providerId,
        expected: `height ${expectedButtonHeight}px`,
        actual: size.button.h,
      });
    }
    const wrapW = Math.round(size.wrap.w ?? -1);
    const wrapH = Math.round(size.wrap.h ?? -1);
    if (wrapW !== expectedWrap || wrapH !== expectedWrap) {
      fail(name, "wrapper-size", {
        providerId: size.providerId,
        expected: `icon wrapper ${expectedWrap}x${expectedWrap}px`,
        actual: `${size.wrap.w}x${size.wrap.h}`,
      });
    }
    if (size.button.left < 0 || size.button.right > info.environment.innerWidth) {
      fail(name, "button-visibility", {
        providerId: size.providerId,
        detail: `button spans ${size.button.left}..${size.button.right} outside viewport 0..${info.environment.innerWidth}`,
      });
    }
  }
  for (const mark of structure.marks) {
    receipt.checks += 4;
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
  }

  // 3. Hit-testing and real taps: five interior points per button.
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
            isMark: el?.closest?.('[data-fixture="icon-wrap"]') != null,
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
          document.querySelector("[data-selected-id]")?.getAttribute("data-selected-id"),
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
    innerWidth: c.environment.innerWidth,
    coarse: c.environment.coarse,
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
