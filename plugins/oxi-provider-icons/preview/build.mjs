import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Bundles the real app.tsx registration (with @get-bb/plugin-sdk/app swapped
// for the preview shim) and writes a synthetic preview page. Everything is
// generated into the ignored preview/dist directory; serve it on a free
// localhost port with any static file server.
await mkdir('preview/dist', { recursive: true });
await build({
  entryPoints: ['preview/main.tsx'],
  bundle: true,
  format: 'esm',
  outfile: 'preview/dist/main.js',
  target: 'es2022',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'preview-sdk-shim',
    setup(builder) {
      builder.onResolve({ filter: /^@get-bb\/plugin-sdk\/app$/ }, () => ({
        path: fileURLToPath(new URL('./sdk.tsx', import.meta.url)),
      }));
    },
  }],
});
await writeFile('preview/dist/index.html', `<!doctype html>
<html lang="en">
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OXI Provider Icons — native picker replica</title>
<style>
:root{--background:#fafafa;--foreground:#24252a;--muted:#f0f0f2;--muted-foreground:#686970;--border:#dedfe3;--accent:#5257cc;--ok:#2f7d4f}
html.dark{--background:#1e1f23;--foreground:#ececf0;--muted:#292a30;--muted-foreground:#a1a2ac;--border:#3b3c44;--accent:#9599f5;--ok:#6fd397}
body{margin:0;background:var(--background);color:var(--foreground);font:14px system-ui,sans-serif}
#note{font-size:11px;color:var(--muted-foreground);padding:6px 12px;border-bottom:1px solid var(--border)}
main{padding:14px 16px;max-width:920px;margin:0 auto}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin:20px 0 8px}
p.hint{font-size:12px;color:var(--muted-foreground);margin:6px 0 10px}
p.status{font-size:13px;font-family:ui-monospace,monospace;margin:10px 0 0}
.toolbar{display:flex;gap:8px;padding:10px 0 4px;flex-wrap:wrap;align-items:center}
.toolbar a{color:var(--accent);text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:3px 9px;font-size:12px}
.toolbar a[aria-current="true"]{border-color:var(--accent);font-weight:600}
.toolbar .sep{width:1px;height:18px;background:var(--border)}
.panel{border:1px solid var(--border);border-radius:10px;background:var(--background);overflow:hidden}
/* Host utilities (Tailwind equivalents) used by the native replica */
.w-auto{width:auto}
.min-w-auto{min-width:auto}
.max-w-auto{max-width:auto}
.size-full{width:100%;height:100%}
/* Mobile model-picker drawer: outer Drawer with width/min/max auto */
.drawer{border:1px solid var(--border);border-radius:10px;background:var(--background);max-width:100%}
.drawer-row{display:flex;gap:2px;padding-left:10px;padding-right:10px;overflow:visible;align-items:center}
.provider-btn{display:inline-flex;align-items:center;justify-content:center;height:28px;width:24px;flex-shrink:1;min-width:auto;padding:0;margin:0;border:1px solid var(--border);border-radius:6px;background:var(--background);color:var(--foreground);cursor:pointer;touch-action:manipulation}
.provider-btn[aria-pressed="true"]{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.icon-wrap{display:inline-flex;width:16px;height:16px;min-width:max-content;min-height:max-content;flex-shrink:0;color:var(--foreground)}
/* Coarse-pointer (touch) geometry: h-9 w-9 buttons, 20 px icon wrapper */
@media (pointer:coarse){
  .provider-btn{height:36px;width:36px}
  .icon-wrap{width:20px;height:20px}
}
/* Provider usage header: size-6 wrapper replica */
.usage-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--border)}
.usage-row:last-child{border-bottom:none}
.usage-row .name{font-weight:500}
.usage-row .pid{margin-left:auto;color:var(--muted-foreground);font-size:11px;font-family:ui-monospace,monospace;white-space:nowrap}
.usage-wrap{display:inline-flex;width:24px;height:24px;min-width:max-content;min-height:max-content;flex-shrink:0;color:var(--foreground)}
</style>
<body>
<div id="note">Preview · native model-picker drawer replica · real icon components from icons.tsx registered through app.tsx · no network</div>
<div id="root"></div>
<script type="module" src="main.js"></script>
</body></html>`);
console.log('Native replica preview built in preview/dist. Serve it on a free localhost port.');
