import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadPluginApp} from '@get-bb/plugin-sdk/testing/app';

// Render the actual interaction component with synthetic metadata only.
const {CredentialForm: component} = await import('./dist/test/app.js');
const output = process.argv[2] ?? 'dist/form-preview';
mkdirSync(output, {recursive: true});
for (const mode of ['store', 'approve']) {
  const payload = {
    mode, title: 'Example server access', username: 'example-user',
    profile: 'admin', projectId: 'example-project', threadId: 'example-thread',
    projectName: 'Example workspace', threadName: 'Настройка доступа к серверу',
    label: 'Example project: administration', hostId: 'example-host', vaultId: 'example-vault',
    hostLabel: 'Example Mac', vaultLabel: 'Example administration',
    purpose: mode === 'store' ? 'Сохранить доступ к серверу' : 'Настроить сервер',
    secrets: mode === 'store' ? [{item: 'Example server access', field: 'Пароль'}] : [{variable: 'EXAMPLE_PASSWORD', item: 'Example server access', field: 'Пароль', reference: 'op://example-vault/example-server/password'}],
  };
  const body = renderToStaticMarkup(React.createElement(component, {
    interaction: {payload}, submit: async () => {}, cancel: () => {},
  }));
  writeFileSync(join(output, mode + '.html'), '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;margin:0;color:#eee;background:#18181b"><main style="max-width:700px;margin:20px auto">' + body + '</main></body></html>');
}
console.log('Rendered intake and approval forms using synthetic data');
