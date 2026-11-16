import { build } from 'esbuild';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { theme: { type: 'string' } } });
await mkdir('preview/dist', { recursive: true });
await build({
  entryPoints: ['preview/entry.tsx'], bundle: true, format: 'esm',
  outfile: 'preview/dist/main.js', target: 'es2022',
  tsconfig: 'tsconfig.json', define: { 'process.env.NODE_ENV': '"development"' },
});
await copyFile('dist/app.css', 'preview/dist/plugin.css');
if (values.theme) await copyFile(values.theme, 'preview/dist/theme.css');
await writeFile('preview/dist/index.html', `<!doctype html>
<html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session tree preview — synthetic data</title>
${values.theme ? '<link rel="stylesheet" href="theme.css">' : ''}<link rel="stylesheet" href="plugin.css">
<style>body{margin:0;font:14px system-ui;background:var(--sidebar,#fafafa);color:var(--foreground,#222)}[data-preview-root]{width:100%;min-height:100vh;padding:12px 6px;overflow:auto}@media(min-width:768px){[data-preview-root]{max-width:360px}}*{box-sizing:border-box}a{color:inherit;text-decoration:none}button{font:inherit}button:not(:disabled){cursor:pointer}</style>
<body><script type="module" src="main.js"></script></body></html>`);
console.log('Synthetic renderer preview built in preview/dist. Serve it on a free localhost port.');
