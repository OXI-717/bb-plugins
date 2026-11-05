import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import plugin from './dist/test/server.js';

const route = {
  projectId: 'example-project', hostId: 'example-host', vaultId: 'example-vault',
  tokenEnvironment: 'EXAMPLE_TOKEN',
  operations: [{name: 'example-operation', argv: ['example-program'], references: {}}],
};
const context = {projectId: route.projectId, threadId: 'example-thread'};

function setup(t, overrides = {}) {
  const host = createFakePluginHost({
    pluginId: 'oxi-op', settings: {routes: JSON.stringify([{...route, ...overrides}])},
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
  assert(!JSON.stringify(interaction).includes('synthetic-sensitive-value'));
  assert(!JSON.stringify(interaction.describeSubmission({password: 'synthetic-sensitive-value'})).includes('synthetic-sensitive-value'));
  h.behavior.submitInteraction(interaction.id, {password: 'synthetic-sensitive-value'});
  const result = await pending;
  const call = h.inspection.experimental_hostRpcCalls.find(x => x.method === 'store');
  assert.equal(call.hostId, route.hostId);
  assert.equal(call.input.password, 'synthetic-sensitive-value');
  assert(!JSON.stringify(result).includes('synthetic-sensitive-value'));
});

test('cancelled intake checks access but never sends a password or writes an item', async t => {
  const h = setup(t);
  const pending = h.behavior.callAgentTool('oxi_op_store', {title: 'Example'}, context);
  await setImmediate();
  h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);
  await pending;
  assert.deepEqual(h.inspection.experimental_hostRpcCalls.map(x => x.method), ['check']);
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
  h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id, {approved: true});
  await pending;
  assert.equal(h.inspection.experimental_hostRpcCalls[0].input.operation, 'example-operation');
});

test('routine operations run without an approval form only when configured', async t => {
  const h = setup(t, {requireApproval: false});
  await h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context);
  assert.equal(h.inspection.pendingInteractions.length, 0);
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 1);
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
