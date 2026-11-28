import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Bundles the real app.tsx registration (with @get-bb/plugin-sdk/app swapped
// for the preview shim) and writes the live-DOM replica preview page. The
// fixture reproduces the host's model-picker markup and media rules instead
// of a synthetic stand-in. Everything is generated into the ignored
// preview/dist directory; serve it on a free localhost port with any static
// file server.
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
<title>OXI Provider Icons — live-DOM picker replica</title>
<style>
:root{--background:#fafafa;--foreground:#24252a;--muted:#f0f0f2;--muted-foreground:#686970;--border:#dedfe3;--accent:#5257cc;--ok:#2f7d4f}
html.dark{--background:#1e1f23;--foreground:#ececf0;--muted:#292a30;--muted-foreground:#a1a2ac;--border:#3b3c44;--accent:#9599f5;--ok:#6fd397}
*{box-sizing:border-box;border-width:0;border-style:solid;border-color:transparent}
body{margin:0;background:var(--background);color:var(--foreground);font:14px system-ui,sans-serif}
button{font:inherit;background:transparent;padding:0;margin:0;color:inherit;cursor:pointer;touch-action:manipulation}
#note{font-size:11px;color:var(--muted-foreground);padding:6px 12px;border-bottom:1px solid var(--border)}
main{padding:14px 16px;max-width:920px;margin:0 auto}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin:20px 0 8px}
p.hint{font-size:12px;color:var(--muted-foreground);margin:6px 0 10px}
p.hint code{font-family:ui-monospace,monospace;font-size:11px}
p.status{font-size:13px;font-family:ui-monospace,monospace;margin:0 0 8px}
.toolbar{display:flex;gap:8px;padding:10px 0 4px;flex-wrap:wrap;align-items:center}
.toolbar a{color:var(--accent);text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:3px 9px;font-size:12px}
.toolbar a[aria-current="true"]{border-color:var(--accent);font-weight:600}
.toolbar .sep{width:1px;height:18px;background:var(--border)}
.panel{border:1px solid var(--border);border-radius:10px;background:var(--background);overflow:hidden}
/* Host utilities (Tailwind equivalents) — live DOM replica */
.flex{display:flex}
.inline-flex{display:inline-flex}
.inline-block{display:inline-block}
.flex-col{flex-direction:column}
.min-h-0{min-height:0}
.p-0{padding:0}
.w-max{width:max-content}
.min-w-64{min-width:16rem}
.max-w-80{max-width:20rem}
.flex-1{flex:1 1 0%}
.shrink-0{flex-shrink:0}
.items-center{align-items:center}
.justify-center{justify-content:center}
.gap-0\\.5{gap:0.125rem}
.border-b{border-bottom-width:1px}
.border-b-2{border-bottom-width:2px}
.border-border{border-color:var(--border)}
.border-transparent{border-color:transparent}
.bg-background{background-color:var(--background)}
.bg-current{background-color:currentColor}
.px-2\\.5{padding-left:0.625rem;padding-right:0.625rem}
.pt-1{padding-top:0.25rem}
.h-7{height:1.75rem}
.w-6{width:1.5rem}
.text-muted-foreground{color:var(--muted-foreground)}
.hover\\:text-foreground:hover{color:var(--foreground)}
.focus-visible\\:outline-none:focus-visible{outline:none}
.transition-none{transition-property:none}
.min-h-max{min-height:max-content}
.min-w-max{min-width:max-content}
.size-4{width:1rem;height:1rem}
.size-5{width:1.25rem;height:1.25rem}
.size-6{width:1.5rem;height:1.5rem}
.size-full{width:100%;height:100%}
.overflow-y-hidden{overflow-y:hidden}
/* The real mobile rule: coarse geometry only when BOTH max-md AND
   pointer:coarse apply — never a plain pointer:coarse override. */
@media (max-width:767.98px) and (pointer:coarse){
  .max-md\\:pointer-coarse\\:h-9{height:2.25rem}
  .max-md\\:pointer-coarse\\:w-9{width:2.25rem}
  .max-md\\:pointer-coarse\\:size-5{width:1.25rem;height:1.25rem}
}
/* Drawer replica chrome (fixture-only visuals) */
.drawer-shell{display:flex;flex-direction:column;min-height:0;border:1px solid var(--border);border-radius:10px;overflow:hidden}
.provider-tab[aria-pressed="true"]{border-bottom-color:var(--accent);color:var(--foreground)}
.drawer-content{padding:10px 12px}
/* Provider usage header: size-6 wrapper replica */
.usage-row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--border)}
.usage-row:last-child{border-bottom:none}
.usage-row .name{font-weight:500}
.usage-row .pid{margin-left:auto;color:var(--muted-foreground);font-size:11px;font-family:ui-monospace,monospace;white-space:nowrap}
</style>
<body>
<div id="note">Preview · live-DOM model-picker replica · real icon components from icons.tsx registered through app.tsx · no network</div>
<div id="root"></div>
<script type="module" src="main.js"></script>
</body></html>`);
console.log('Live-DOM replica preview built in preview/dist. Serve it on a free localhost port.');
