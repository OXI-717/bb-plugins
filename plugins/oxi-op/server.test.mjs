import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {loadPluginApp} from '@get-bb/plugin-sdk/testing/app';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import plugin from './dist/test/server.js';

const route = {
  projectId: 'example-project', hostId: 'example-host', vaultId: 'example-vault',
  tokenEnvironment: 'EXAMPLE_TOKEN',
  operations: [{name: 'example-operation', label: 'Check server access', purpose: 'Configure the example server', argv: ['example-program'], references: {EXAMPLE_PASSWORD: 'op://example-vault/example-server/password'}, referenceLabels: {EXAMPLE_PASSWORD: {item: 'Example server', field: 'Password'}}}],
};
const context = {projectId: route.projectId, threadId: 'example-thread'};

function setup(t, overrides = {}) {
  const host = createFakePluginHost({
    pluginId: 'oxi-op', settings: {routes: JSON.stringify([{...route, ...overrides}])},
    sdk: {
      projects: {get: async ({projectId}) => ({id: projectId, name: 'Example workspace'})},
      threads: {get: async ({threadId}) => ({id: threadId, projectId: route.projectId, title: 'Example session'})},
      hosts: {get: async ({hostId}) => ({id: hostId, name: 'Example machine'})},
    },
    experimental_callHostRpc: ({method}) => method === 'store'
      ? {itemId: 'example-item', verified: true} : method === 'check' ? {authorized: true} : {completed: true},
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
  await assert.rejects(h.behavior.callAgentTool('oxi_op_store', {title: 'Example'}, {...context, projectId: 'other-project'}));
  assert.equal(h.inspection.pendingInteractions.length, 0);
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
});

test('critical operations wait for explicit approval and reject unconfigured commands', async t => {
  const h = setup(t);
  await assert.rejects(h.behavior.callAgentTool('oxi_op_run', {operation: 'unknown'}, context));
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

test('service tokens use native secret settings and never appear in tool results', async t => {
  const h = setup(t, {tokenEnvironment: undefined, tokenSetting: 'serviceAccountToken', requireApproval: false});
  await h.behavior.setSettings({serviceAccountToken: 'synthetic-service-value'});
  const result = await h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context);
  assert.equal(h.inspection.experimental_hostRpcCalls[0].input.serviceAccountToken, 'synthetic-service-value');
  assert(!JSON.stringify(result).includes('synthetic-service-value'));
});

test('one project can separate routine and administrative vault access', async t => {
  const h = setup(t);
  await h.behavior.setSettings({routes: JSON.stringify([
    {...route, profile: 'routine', requireApproval: false},
    {...route, profile: 'admin', vaultId: 'example-admin-vault'},
  ])});
  await assert.rejects(h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context));
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
