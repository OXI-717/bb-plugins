import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {loadPluginApp} from '@get-bb/plugin-sdk/testing/app';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import plugin from './dist/test/server.js';
import {createJournal} from './dist/test/journal.js';

const route = {
  projectId: 'example-project', hostId: 'example-host', vaultId: 'example-vault',
  tokenEnvironment: 'EXAMPLE_TOKEN',
  operations: [{name: 'example-operation', label: 'Check server access', purpose: 'Configure the example server', argv: ['example-program'], references: {EXAMPLE_PASSWORD: 'op://example-vault/example-server/password'}, referenceLabels: {EXAMPLE_PASSWORD: {item: 'Example server', field: 'Password'}}}],
};
const context = {projectId: route.projectId, threadId: 'example-thread'};

function setup(t, overrides = {}, callHost, send) {
  const host = createFakePluginHost({
    pluginId: 'oxi-op', settings: {routes: JSON.stringify([{...route, ...overrides}])},
    sdk: {
      projects: {get: async ({projectId}) => ({id: projectId, name: 'Example workspace'})},
      threads: {get: async ({threadId}) => ({id: threadId, projectId: route.projectId, title: 'Example session'}), send: send ?? (async () => ({delivery: 'sent'}))},
      hosts: {get: async ({hostId}) => ({id: hostId, name: 'Example machine'})},
    },
    experimental_callHostRpc: callHost ?? (({method}) => method === 'store'
      ? {itemId: 'example-item', verified: true} : method === 'check' ? {authorized: true} : {completed: true}),
  });
  plugin(host.bb);
  t.after(() => host.harness.lifecycle.dispose());
  return host.harness;
}

test('native intake keeps the password out of interaction metadata and tool result', async t => {
  const h = setup(t);
  const pending = h.behavior.callAgentTool('oxi_op_store', {title: 'Example', username: 'example'}, context);
  await setImmediate();
  const interaction = h.inspection.pendingInteractions[0];
  assert.equal(interaction.threadId, context.threadId);
  assert.equal(interaction.payload.vaultId, route.vaultId);
  assert.equal(interaction.payload.secrets[0].item, 'Example');
  assert.equal(interaction.payload.secrets[0].field, 'password');
  assert.equal(interaction.payload.threadId, context.threadId);
  assert.equal(interaction.payload.projectName, 'Example workspace');
  assert.equal(interaction.payload.threadName, 'Example session');
  assert.equal(interaction.payload.hostLabel, 'Example machine');
  assert(!JSON.stringify(interaction).includes('synthetic-sensitive-value'));
  assert(!JSON.stringify(interaction.describeSubmission({password: 'synthetic-sensitive-value'})).includes('synthetic-sensitive-value'));
  h.behavior.submitInteraction(interaction.id, {password: 'synthetic-sensitive-value'});
  const result = await pending;
  const call = h.inspection.experimental_hostRpcCalls.find(x => x.method === 'store');
  assert.equal(call.hostId, route.hostId);
  assert.equal(call.input.password, 'synthetic-sensitive-value');
  assert(!JSON.stringify(result).includes('synthetic-sensitive-value'));
});

test('intake shows its BB form before any op authentication and cancellation does not contact op', async t => {
  const h = setup(t);
  const pending = h.behavior.callAgentTool('oxi_op_store', {title: 'Example'}, context);
  await setImmediate();
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
  h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);
  await pending;
  assert.deepEqual(h.inspection.experimental_hostRpcCalls, []);
});

test('an unconfigured project cannot request a form or call a host', async t => {
  const h = setup(t);
  assert.equal(JSON.parse(await h.behavior.callAgentTool('oxi_op_store', {title: 'Example'}, {...context, projectId: 'other-project'})).completed, false);
  assert.equal(h.inspection.pendingInteractions.length, 0);
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
});

test('owner registry setup shows a BB approval before any desktop CLI call', async t => {
  const h = setup(t, {authentication: 'desktop', accountId: 'example-account', tokenEnvironment: undefined});
  const pending = h.behavior.runCli(['inventory', '--title', 'Example registry'], context);
  await setImmediate();
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
  const interaction = h.inspection.pendingInteractions[0];
  assert.equal(interaction.payload.title, 'Сверка служебных сейфов');
  assert.equal(interaction.payload.secrets[0].item, 'Example registry');
  h.behavior.cancelInteraction(interaction.id);
  await pending;
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
});

test('completed intake is recoverable without retaining the submitted password', async t => {
  const h = setup(t);
  const pending = h.behavior.callAgentTool('oxi_op_store', {title: 'Example'}, context);
  await setImmediate();
  h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id, {password: 'synthetic-sensitive-value'});
  await pending;
  const response = await h.behavior.runCli(['history'], context);
  const rows = JSON.parse(response.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'completed');
  assert.equal(rows[0].label, 'Example');
  assert.deepEqual(rows[0].result, {itemId: 'example-item', verified: true});
  assert(!response.stdout.includes('synthetic-sensitive-value'));
  assert.equal(JSON.parse((await h.behavior.runCli(['history'], {...context, threadId: 'other-thread'})).stdout).length, 0);
  const reloaded = await h.lifecycle.reload(plugin);
  t.after(() => reloaded.harness.lifecycle.dispose());
  assert.deepEqual(JSON.parse((await reloaded.harness.behavior.runCli(['history'], context)).stdout), rows);
});

test('restart marks unfinished work as interrupted and concurrent records cannot overwrite each other', async () => {
  const data = new Map();
  const storage = {get: async key => data.get(key), set: async (key, value) => data.set(key, structuredClone(value)), list: async prefix => [...data.keys()].filter(key => key.startsWith(prefix))};
  const first = createJournal(storage);
  let finish;
  const pending = first.run('run', 'default', context, async progress => {
    await progress('running', true);
    return new Promise(resolve => {finish = resolve;});
  });
  await setImmediate();
  await first.run('run', 'default', context, async () => JSON.stringify({completed: true}));
  const restarted = createJournal(storage);
  const rows = await restarted.list(context);
  assert.equal(rows.length, 2);
  assert(rows.some(row => row.state === 'completed'));
  assert(rows.some(row => row.state === 'interrupted' && row.approvedAt));
  finish(JSON.stringify({completed: true}));
  await pending;
});

test('approval and execution states remain visible while the host is busy', async t => {
  let finish;
  const h = setup(t, {}, () => new Promise(resolve => {finish = resolve;}));
  const pending = h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context);
  await setImmediate();
  let rows = JSON.parse((await h.behavior.runCli(['history'], context)).stdout);
  assert.equal(rows[0].state, 'awaiting-approval');
  h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id, {approved: true});
  await setImmediate();
  rows = JSON.parse((await h.behavior.runCli(['history'], context)).stdout);
  assert.equal(rows[0].state, 'running');
  assert(rows[0].approvedAt);
  finish({completed: true});
  await pending;
  rows = JSON.parse((await h.behavior.runCli(['history'], context)).stdout);
  assert.equal(rows[0].state, 'completed');
});

test('uncertain host failures are recorded without raw exception text and cancellation is distinct', async t => {
  const h = setup(t, {}, () => {throw new Error('synthetic-sensitive-value');});
  const pending = h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context);
  await setImmediate();
  h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id, {approved: true});
  const outcome = JSON.parse(await pending);
  assert.equal(outcome.completed, false);
  assert(!JSON.stringify(outcome).includes('synthetic-sensitive-value'));
  let response = await h.behavior.runCli(['history'], context);
  assert.equal(JSON.parse(response.stdout)[0].state, 'needs-review');
  assert(!response.stdout.includes('synthetic-sensitive-value'));
  const cancelled = h.behavior.callAgentTool('oxi_op_store', {title: 'Other example'}, context);
  await setImmediate();
  h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);
  await cancelled;
  response = await h.behavior.runCli(['history'], context);
  assert(JSON.parse(response.stdout).some(x => x.state === 'cancelled'));
});

test('desktop check and verification require contextual approval before contacting op', async t => {
  for (const command of ['check', 'verify']) {
    const h = setup(t, {authentication: 'desktop', accountId: 'example-account', tokenEnvironment: undefined});
    const pending = h.behavior.runCli([command], context);
    await setImmediate();
    assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
    assert.equal(h.inspection.pendingInteractions.length, 1);
    h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);
    await pending;
  }
});

test('critical operations wait for explicit approval and reject unconfigured commands', async t => {
  const h = setup(t);
  assert.equal(JSON.parse(await h.behavior.callAgentTool('oxi_op_run', {operation: 'unknown'}, context)).completed, false);
  const pending = h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context);
  await setImmediate();
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
  const payload = h.inspection.pendingInteractions[0].payload;
  assert.equal(payload.threadId, context.threadId);
  assert.equal(payload.purpose, 'Configure the example server');
  assert.equal(payload.title, 'Check server access');
  assert.equal(payload.secrets[0].item, 'Example server');
  assert.equal(payload.secrets[0].reference, 'op://example-vault/example-server/password');
  const app = await loadPluginApp(() => import('./dist/test/app.js'));
  const html = renderToStaticMarkup(React.createElement(app.pendingInteractions[0].component, {
    interaction: {payload}, submit: async () => {}, cancel: () => {},
  }));
  for (const value of [context.projectId, context.threadId, payload.purpose, payload.secrets[0].reference, route.hostId, route.vaultId]) assert(html.includes(value));
  const visible = html.split('<details>')[0];
  for (const value of ['Example workspace', 'Example session', 'Example machine', 'Example server']) assert(visible.includes(value));
  for (const value of [context.projectId, context.threadId, route.hostId, route.vaultId, 'op://']) assert(!visible.includes(value));
  h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id, {approved: true});
  await pending;
  assert.equal(h.inspection.experimental_hostRpcCalls[0].input.operation, 'example-operation');
});

test('unavailable BB names are explicit and never replaced with opaque IDs', async t => {
  const h = setup(t);
  h.sdk.stub('projects.get', async () => {throw Error('unavailable');});
  h.sdk.stub('threads.get', async () => ({id: 'other-thread', projectId: route.projectId, title: 'Wrong session'}));
  h.sdk.stub('hosts.get', async () => ({id: 'other-host', name: 'Wrong machine'}));
  const pending = h.behavior.callAgentTool('oxi_op_store', {title: 'Example'}, context);
  await setImmediate();
  const payload = h.inspection.pendingInteractions[0].payload;
  assert.equal(payload.projectName, 'Название проекта недоступно');
  assert.equal(payload.threadName, 'Название сессии недоступно');
  assert.equal(payload.hostLabel, 'Название машины недоступно');
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
  h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);
  await pending;
});

test('routine operations run without an approval form only when configured', async t => {
  const h = setup(t, {requireApproval: false});
  await h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context);
  assert.equal(h.inspection.pendingInteractions.length, 0);
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 1);
});

test('CLI operation uses the same approval gate and accepts no arbitrary command', async t => {
  const h = setup(t);
  const pending = h.behavior.runCli(['run', 'example-operation'], context);
  await setImmediate();
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
  assert.equal(h.inspection.pendingInteractions[0].payload.secrets[0].reference, route.operations[0].references.EXAMPLE_PASSWORD);
  h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id, {approved: true});
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(h.inspection.experimental_hostRpcCalls[0].method, 'run');
  assert(!result.stdout.includes('op://'));
});

test('interactive CLI can return completion to the same session without sending secret values', async t => {
  const notices = [];
  const h = setup(t, {}, undefined, async input => {notices.push(input); return {delivery: 'sent'};});
  const pending = h.behavior.runCli(['run', 'example-operation', '--notify'], context);
  await setImmediate();
  assert.equal(notices.length, 0);
  assert.equal(h.inspection.pendingInteractions[0].timeoutMs, 60 * 60 * 1000);
  h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id, {approved: true});
  assert.equal((await pending).exitCode, 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].threadId, context.threadId);
  assert.equal(notices[0].mode, 'queue-if-active');
  assert(!JSON.stringify(notices).includes('op://'));
});

test('CLI notification failures never retry an already completed credential operation', async t => {
  let notices = 0;
  const h = setup(t, {requireApproval: false}, undefined, async () => {notices++; throw Error('synthetic-sensitive-value');});
  const result = await h.behavior.runCli(['run', 'example-operation', '--notify'], context);
  assert.equal(result.exitCode, 0);
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 1);
  assert.equal(notices, 1);
  assert(!JSON.stringify(result).includes('synthetic-sensitive-value'));
});

test('CLI completion cannot resume a stopped request or a thread outside its original project', async t => {
  const notices=[];
  const h=setup(t, {requireApproval:false}, undefined, async input => {notices.push(input);return {delivery:'sent'};});
  const controller=new AbortController(); controller.abort();
  await h.behavior.runCli(['run','example-operation','--notify'], {...context, signal:controller.signal});
  await h.behavior.runCli(['run','example-operation','--notify'], {...context, projectId:'other-project'});
  assert.equal(notices.length,0);
});

test('service tokens use native secret settings and never appear in tool results', async t => {
  const h = setup(t, {tokenEnvironment: undefined, tokenSetting: 'serviceAccountToken', requireApproval: false});
  await h.behavior.setSettings({serviceAccountToken: 'synthetic-service-value'});
  const result = await h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context);
  assert.equal(h.inspection.experimental_hostRpcCalls[0].input.serviceAccountToken, 'synthetic-service-value');
  assert(!JSON.stringify(result).includes('synthetic-service-value'));
});

test('approved remote desktop operation resolves on its credential host and executes only on its target', async t => {
  const h = setup(t, {authentication: 'desktop', accountId: 'example-account', tokenEnvironment: undefined, credentialHostId: 'example-credential-host'}, ({method}) => method === 'resolve' ? {bindings: {EXAMPLE_PASSWORD: 'synthetic-sensitive-value'}} : {completed: true});
  const pending = h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context);
  await setImmediate();
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
  assert(h.inspection.pendingInteractions[0].payload.purpose.includes('Авторизация 1Password: Example machine'));
  h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id, {approved: true});
  const result = await pending;
  const calls = h.inspection.experimental_hostRpcCalls;
  assert.deepEqual(calls.map(x => [x.method, x.hostId]), [['resolve', 'example-credential-host'], ['execute', route.hostId]]);
  assert.equal(calls[1].input.bindings.EXAMPLE_PASSWORD, 'synthetic-sensitive-value');
  assert(!JSON.stringify(result).includes('synthetic-sensitive-value'));
  assert(!(await h.behavior.runCli(['history'], context)).stdout.includes('synthetic-sensitive-value'));
});

test('cancelling remote desktop access contacts neither host', async t => {
  const h = setup(t, {authentication: 'desktop', accountId: 'example-account', tokenEnvironment: undefined, credentialHostId: 'example-credential-host'});
  const pending = h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context);
  await setImmediate();
  h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);
  await pending;
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
});

test('one project can separate routine and administrative vault access', async t => {
  const h = setup(t);
  await h.behavior.setSettings({routes: JSON.stringify([
    {...route, profile: 'routine', requireApproval: false},
    {...route, profile: 'admin', vaultId: 'example-admin-vault'},
  ])});
  assert.equal(JSON.parse(await h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context)).completed, false);
  await h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation', profile: 'routine'}, context);
  const pending = h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation', profile: 'admin'}, context);
  await setImmediate();
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 1);
  assert.equal(h.inspection.pendingInteractions[0].payload.vaultId, 'example-admin-vault');
  h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);
  await pending;
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 1);
  await assert.rejects(h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation', argv: ['unconfigured']}, context));
});
