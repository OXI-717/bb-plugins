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
<title>OXI Provider Icons — synthetic preview</title>
<style>
:root{--background:#fafafa;--foreground:#24252a;--muted:#f0f0f2;--muted-foreground:#686970;--border:#dedfe3;--accent:#5257cc;--ok:#2f7d4f}
html.dark{--background:#1e1f23;--foreground:#ececf0;--muted:#292a30;--muted-foreground:#a1a2ac;--border:#3b3c44;--accent:#9599f5;--ok:#6fd397}
body{margin:0;background:var(--background);color:var(--foreground);font:14px system-ui,sans-serif}
#note{font-size:11px;color:var(--muted-foreground);padding:6px 12px;border-bottom:1px solid var(--border)}
main{padding:14px 16px;max-width:920px;margin:0 auto}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted-foreground);margin:20px 0 8px}
p.hint{font-size:12px;color:var(--muted-foreground);margin:6px 0 10px}
.toolbar{display:flex;gap:8px;padding:10px 0 4px;flex-wrap:wrap;align-items:center}
.toolbar a{color:var(--accent);text-decoration:none;border:1px solid var(--border);border-radius:6px;padding:3px 9px;font-size:12px}
.toolbar a[aria-current="true"]{border-color:var(--accent);font-weight:600}
.toolbar .sep{width:1px;height:18px;background:var(--border)}
.panel{border:1px solid var(--border);border-radius:10px;background:var(--background);overflow:hidden}
.row{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid var(--border)}
.row:last-child{border-bottom:none}
.row .name{font-weight:500}
.row .pid{margin-left:auto;color:var(--muted-foreground);font-size:11px;font-family:ui-monospace,monospace;white-space:nowrap}
.pi{display:inline-flex;flex:none;color:var(--foreground)}
.pi-14{width:14px;height:14px}
.pi-16{width:16px;height:16px}
.usage{height:4px;border-radius:2px;background:var(--muted);flex:1;max-width:130px;overflow:hidden}
.usage>i{display:block;height:100%;background:var(--accent)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
.card{border:1px solid var(--border);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:5px;min-width:0}
.card .pair{display:flex;align-items:center;gap:10px}
.card .id{font-family:ui-monospace,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis}
.badge{align-self:flex-start;display:inline-block;font-size:10px;padding:1px 7px;border-radius:999px;border:1px solid var(--border);color:var(--muted-foreground)}
.badge.registered{color:var(--ok);border-color:var(--ok)}
</style>
<body>
<div id="note">Preview · synthetic picker and usage chrome · real icon components from icons.tsx registered through app.tsx · no network</div>
<div id="root"></div>
<script type="module" src="main.js"></script>
</body></html>`);
console.log('Synthetic preview built in preview/dist. Serve it on a free localhost port.');
