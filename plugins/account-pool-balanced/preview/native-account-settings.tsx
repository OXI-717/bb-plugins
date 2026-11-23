/** Visual acceptance of the real account rows, with synthetic state. */
import React from 'react';
import {readFileSync} from 'node:fs';
import {renderToStaticMarkup} from 'react-dom/server';
import {AccountListRow, AccountRowStatus, SettingsBadge} from '../account-list-row';
import {NativeAccountRow, NativeAccountSettings} from '../native-account-settings';
import {accountSettingsCss} from '../account-settings-style';
import type {NativeAccounts} from '../src/native-accounts';

(globalThis as typeof globalThis & {React: typeof React}).React = React;

const account: NativeAccounts['accounts'][number] = {
  accountId: 'example-subscription', label: 'long-antigravity-account@example.com', role: 'primary', priority: 1,
  projects: {onlySelected: true, rules: [{projectId: 'example-project', role: 'primary'}]},
  projectsRevision: 'a'.repeat(64), mixedProjects: false,
  executors: [{id: 'example-server', hostId: 'example-host', enabled: true, autopilotAllowed: true}],
  active: 2, queued: 1, uncertain: 0, maxConcurrentSessions: 2,
};
const disabledAccount: typeof account = {
  ...account,
  accountId: 'reserve-subscription',
  label: 'reserve@example.com',
  role: 'reserve',
  projects: {onlySelected: false, rules: []},
  executors: [],
  active: 0,
  queued: 0,
  maxConcurrentSessions: 1,
};
const loadProjects = async () => [{id: 'example-project', name: 'Example project'}];
const open = () => {};
const content = (
  <main data-bb-plugin="account-pool-balanced" className="space-y-6">
    <section>
      <h1 className="mb-2 text-sm font-semibold">Antigravity</h1>
      <div className="divide-y divide-border border-t border-border">
        <NativeAccountRow account={account} open={open} />
        <NativeAccountRow account={disabledAccount} open={open} />
      </div>
    </section>
    <section>
      <h2 className="mb-2 text-sm font-semibold">NeuralDeep</h2>
      <div className="border-t border-border">
        <AccountListRow
          name="long-api-account-name@example.com"
          enabled
          badges={
            <>
              <SettingsBadge>API key</SettingsBadge>
              <SettingsBadge>Custom settings</SettingsBadge>
              <SettingsBadge>Project roles · 3</SettingsBadge>
              <SettingsBadge>Reserve</SettingsBadge>
            </>
          }
          status={<AccountRowStatus label="Active" dot="bg-success" />}
          metrics={<span className="text-xs">5H —</span>}
          actions={null}
          onOpen={open}
        />
      </div>
    </section>
    <section className="pool-settings">
      <h2 className="mb-2 text-sm font-semibold">Settings · {account.label}</h2>
      <NativeAccountSettings account={account} revision={'b'.repeat(64)} save={async () => {}} loadProjects={loadProjects} />
    </section>
  </main>
);
const css = readFileSync(new URL('../dist/app.css', import.meta.url), 'utf8');
process.stdout.write('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account settings preview</title><style>' + css + accountSettingsCss + '@layer base{button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;padding:0}}body{font-family:system-ui;margin:24px auto;padding:0 16px;max-width:760px;background:#fff;color:#202124;--border:#d9dde3;--muted:#edf0f4;--muted-foreground:#596575;--subtle-foreground:#475569;--primary:#272a30;--primary-foreground:#fff;--foreground:#202124;--background:#fff;--success:#16824a;--warning:#b87408;--radius:.5rem}</style>' + renderToStaticMarkup(content) + '</html>');
