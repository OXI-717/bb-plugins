import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {createFakePluginHost} from '@get-bb/plugin-sdk/testing';
import {loadPluginApp} from '@get-bb/plugin-sdk/testing/app';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import plugin from './dist/test/server.js';
import {createJournal, cancelledOutcome} from './dist/test/journal.js';

const route = {
  projectId: 'example-project', hostId: 'example-host', vaultId: 'example-vault',
  tokenEnvironment: 'EXAMPLE_TOKEN',
  operations: [{name: 'example-operation', label: 'Check server access', purpose: 'Configure the example server', argv: ['example-program'], references: {EXAMPLE_PASSWORD: 'op://example-vault/example-server/password'}, referenceLabels: {EXAMPLE_PASSWORD: {item: 'Example server', field: 'Password'}}}],
};
const context = {projectId: route.projectId, threadId: 'example-thread'};

function setup(t, overrides = {}, callHost, send, listInteractions = async () => [], hostStatus = 'connected') {
  const host = createFakePluginHost({
    pluginId: 'oxi-op', settings: {routes: JSON.stringify([{...route, ...overrides}])},
    sdk: {
      projects: {get: async ({projectId}) => ({id: projectId, name: 'Example workspace'})},
      threads: {get: async ({threadId}) => ({id: threadId, projectId: route.projectId, title: 'Example session'}), send: send ?? (async () => ({delivery: 'sent'})), interactions: {list: listInteractions}},
      hosts: {get: async ({hostId}) => ({id: hostId, name: 'Example machine', status: typeof hostStatus === 'function' ? hostStatus(hostId) : hostStatus})},
    },
    experimental_callHostRpc: callHost ?? (({method}) => method === 'store'
      ? {itemId: 'example-item', verified: true} : method === 'check' ? {authorized: true} : {completed: true}),
  });
  plugin(host.bb);
  t.after(() => host.harness.lifecycle.dispose());
  return host.harness;
}

test('display diagnostics record rendering without granting or contacting a credential host', async t => {
  let h;
  h = setup(t, {}, undefined, undefined, async () => h.inspection.pendingInteractions.map(x => ({id:x.id,origin:{kind:'plugin',pluginId:'oxi-op'}})));
  const pending = h.behavior.runCli(['display-test'], context);
  await setImmediate();
  const form = h.inspection.pendingInteractions[0];
  assert(form);
  await h.behavior.callRpc('formReceipt', {threadId:context.threadId,interactionId:form.id,visible:true});
  assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
  const rows=JSON.parse((await h.behavior.runCli(['display-status'],context)).stdout);
  assert.equal(rows[0].visibleEver,true);
  await assert.rejects(h.behavior.callRpc('formReceipt',{threadId:context.threadId,interactionId:'other-form',visible:true}));
  await assert.rejects(h.behavior.callRpc('formReceipt',{threadId:context.threadId,interactionId:form.id,visible:true,password:'synthetic-sensitive-value'}));
  h.behavior.cancelInteraction(form.id);
  await pending;
  assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
});

test('native intake keeps the password out of interaction metadata and tool result', async t => {
  const h = setup(t);
  const pending = h.behavior.callAgentTool('oxi_op_store', {title: 'Example', username: 'example'}, context);
  await setImmediate();
  const interaction = h.inspection.pendingInteractions[0];
  assert.equal(interaction.timeoutMs, 60_000);
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

test('native and CLI forms expire at one minute without contacting either credential host', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  for (const mode of ['native', 'cli']) {
    const notices=[];
    const h = setup(t, {authentication: 'desktop', accountId: 'example-account', tokenEnvironment: undefined, credentialHostId: 'example-credential-host'}, undefined, async input=>{notices.push(input);return {delivery:'sent'};});
    let settled = false;
    const pending = (mode === 'native'
      ? h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation'}, context)
      : h.behavior.runCli(['run', 'example-operation', '--notify'], context)).then(value => {settled = true; return value;});
    await setImmediate();
    t.mock.timers.tick(59_999);
    await setImmediate();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(h.inspection.pendingInteractions.length, 0);
    assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
    assert.equal(JSON.parse((await h.behavior.runCli(['history'], context)).stdout)[0].state, 'cancelled');
    assert.equal(JSON.parse((await h.behavior.runCli(['history'], context)).stdout)[0].cancelReason, 'timeout');
    if(mode==='cli')assert(notices[0].input[0].text.includes('отменён по истечении 60 секунд'));
  }
});

test('an unconfigured project cannot request a form or call a host', async t => {
  const h = setup(t);
  assert.equal(JSON.parse(await h.behavior.callAgentTool('oxi_op_store', {title: 'Example'}, {...context, projectId: 'other-project'})).completed, false);
  assert.equal(h.inspection.pendingInteractions.length, 0);
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
});

test('owner registry setup shows a BB approval before any desktop CLI call', async t => {
  const h = setup(t, {authentication: 'desktop', accountId: 'example-account', tokenEnvironment: undefined, credentialHostId: 'example-credential-host'});
  const pending = h.behavior.runCli(['inventory', '--title', 'Example registry'], context);
  await setImmediate();
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
  const interaction = h.inspection.pendingInteractions[0];
  assert.equal(interaction.payload.title, 'Сверка служебных сейфов');
  assert.equal(interaction.payload.hostId, 'example-credential-host');
  assert.equal(interaction.payload.secrets[0].item, 'Example registry');
  h.behavior.cancelInteraction(interaction.id);
  await pending;
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 0);
});

test('intake identifies the credential machine rather than a separate execution machine', async t => {
  const h = setup(t, {authentication: 'desktop', accountId: 'example-account', tokenEnvironment: undefined, credentialHostId: 'example-credential-host'});
  const pending = h.behavior.callAgentTool('oxi_op_store', {title: 'Example'}, context);
  await setImmediate();
  assert.equal(h.inspection.pendingInteractions[0].payload.hostId, 'example-credential-host');
  h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id, {password: 'synthetic-sensitive-value'});
  await pending;
  assert.equal(h.inspection.experimental_hostRpcCalls[0].hostId, 'example-credential-host');
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
  const {CredentialForm} = await import('./dist/test/app.js');
  const html = renderToStaticMarkup(React.createElement(CredentialForm, {
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
  const pending = h.behavior.runCli(['display-test'], context);
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
  assert.equal(h.inspection.pendingInteractions[0].timeoutMs, 60_000);
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

test('project service tokens are selected by both project and profile without a shared fallback', async t => {
  const h = setup(t, {tokenEnvironment: undefined, tokenSetting: 'projectServiceAccounts', profile: 'routine', requireApproval: false});
  await h.behavior.setSettings({projectServiceAccounts: JSON.stringify({[route.projectId]: {routine: 'synthetic-first-token'}, 'other-project': {routine: 'synthetic-second-token'}}), serviceAccountToken: 'synthetic-legacy-token', routes: JSON.stringify([
    {...route, profile: 'routine', tokenEnvironment: undefined, tokenSetting: 'projectServiceAccounts', requireApproval: false},
    {...route, projectId: 'other-project', profile: 'routine', tokenEnvironment: undefined, tokenSetting: 'projectServiceAccounts', requireApproval: false},
    {...route, profile: 'admin', tokenEnvironment: undefined, tokenSetting: 'projectServiceAccounts', requireApproval: false},
  ])});
  await h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation', profile: 'routine'}, context);
  await h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation', profile: 'routine'}, {...context, projectId: 'other-project'});
  assert.deepEqual(h.inspection.experimental_hostRpcCalls.map(x => x.input.serviceAccountToken), ['synthetic-first-token', 'synthetic-second-token']);
  const missing = await h.behavior.callAgentTool('oxi_op_run', {operation: 'example-operation', profile: 'admin'}, context);
  assert.equal(JSON.parse(missing).completed, false);
  assert.equal(h.inspection.experimental_hostRpcCalls.length, 2);
  assert(!(await h.behavior.runCli(['history'], context)).stdout.includes('synthetic-first-token'));
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

test('project connection requires desktop approval and preserves existing project routes',async t=>{
 const h=setup(t,{authentication:'desktop',accountId:'example-account',tokenEnvironment:undefined,credentialHostId:'example-credential-host'},({method})=>{
  assert.equal(method,'provisionVault');return {vaultId:'example-target-vault',name:'Example workspace'};
 });
 const args=['connect','--project','target-project','--profile','default'];
 const cancelled=h.behavior.runCli(args,context);await setImmediate();
 assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
 assert.equal(h.inspection.pendingInteractions[0].timeoutMs,60_000);
 h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);await cancelled;
 assert.equal((await h.behavior.runCli(['status'],{...context,projectId:'target-project'})).exitCode,1);
 const work=h.behavior.runCli(args,context);await setImmediate();
 h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id,{approved:true});
 const result=JSON.parse((await work).stdout);assert.equal(result.configured,true);
 assert.equal(h.inspection.experimental_hostRpcCalls[0].hostId,'example-credential-host');
 const target=JSON.parse((await h.behavior.runCli(['status'],{...context,projectId:'target-project'})).stdout);
 assert.equal(target.vaultId,'example-target-vault');assert.equal(target.requireApproval,true);assert.deepEqual(target.operations,[]);
 assert.equal(JSON.parse((await h.behavior.runCli(['status'],context)).stdout).vaultId,route.vaultId);
 assert.equal((await h.behavior.runCli(args,context)).exitCode,1);
 assert.equal(h.inspection.experimental_hostRpcCalls.length,1);
 assert.equal(JSON.parse((await h.behavior.runCli(['history'],context)).stdout).some(x=>x.kind==='connect'&&x.state==='completed'),true);
});
test('service account routing cannot bootstrap a desktop project connection',async t=>{
 const h=setup(t);
 assert.equal((await h.behavior.runCli(['connect','--project','target-project','--profile','default'],context)).exitCode,1);
 assert.equal(h.inspection.experimental_hostRpcCalls.length,0);assert.equal(h.inspection.pendingInteractions.length,0);
});

test('batch connection gates all writes once, preserves partial progress and skips configured projects',async t=>{
 const h=setup(t,{authentication:'desktop',accountId:'example-account',tokenEnvironment:undefined},({input})=>{
  if(input.projectId==='failed-project')throw new Error('sensitive provider details');
  return {vaultId:'vault-'+input.projectId,name:'Example workspace'};
 });
 const targets=[{projectId:'target-one',existingVaultId:'existing-vault'},{projectId:'failed-project'},{projectId:'target-two'}];
 const args=['connect-many','--projects',JSON.stringify(targets),'--profile','default'];
 const cancelled=h.behavior.runCli(args,context);await setImmediate();
 assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
 assert.equal(h.inspection.pendingInteractions[0].timeoutMs,60_000);
 h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);await cancelled;
 const work=h.behavior.runCli(args,context);await setImmediate();
 h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id,{approved:true});
 const result=JSON.parse((await work).stdout);
 assert.deepEqual(result.projects.map(p=>p.state),['configured','needs-review','configured']);
 assert.equal(h.inspection.experimental_hostRpcCalls[0].input.existingVaultId,'existing-vault');
 assert(!JSON.stringify(result).includes('sensitive'));
 assert.equal(JSON.parse((await h.behavior.runCli(['status'],{...context,projectId:'target-two'})).stdout).configured,true);
 const before=h.inspection.experimental_hostRpcCalls.length;
 const skip=await h.behavior.runCli(['connect-many','--projects',JSON.stringify([targets[0],targets[2]]),'--profile','default'],context);
 assert(JSON.parse(skip.stdout).projects.every(p=>p.state==='already-configured'));
 assert.equal(h.inspection.experimental_hostRpcCalls.length,before);
 assert.equal(h.inspection.pendingInteractions.length,0);
 assert.equal((await h.behavior.runCli(['connect-many','--projects',JSON.stringify([targets[0],targets[0]]),'--profile','default'],context)).exitCode,1);
});

test('explicit cancellation is recorded separately from timeout without storing input',async t=>{
 const h=setup(t);
 const work=h.behavior.callAgentTool('oxi_op_store',{title:'Example'},context);
 await setImmediate();h.behavior.cancelInteraction(h.inspection.pendingInteractions[0].id);await work;
 const row=JSON.parse((await h.behavior.runCli(['history'],context)).stdout)[0];
 assert.equal(row.state,'cancelled');assert.equal(row.cancelReason,'user');
 assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
});

test('unknown cancellation reasons never enter the journal or completion text',async()=>{
 assert.equal(cancelledOutcome({outcome:'cancelled',reason:'synthetic-sensitive-value'}),'Cancelled');
 assert.equal(cancelledOutcome({outcome:'submitted'}),'Cancelled: invalid-submission');
 const data=new Map();const storage={get:async k=>data.get(k),set:async(k,v)=>data.set(k,structuredClone(v)),list:async prefix=>[...data.keys()].filter(k=>k.startsWith(prefix))};
 const journal=createJournal(storage);
 await journal.run('run','default',context,async()=>cancelledOutcome({outcome:'cancelled',reason:'synthetic-sensitive-value'}));
 const rows=await journal.list(context);assert.equal(rows[0].state,'cancelled');assert.equal(rows[0].cancelReason,undefined);assert(!JSON.stringify(rows).includes('synthetic-sensitive-value'));
});

test('offline credential host fails before intake without requesting a password',async t=>{
 const h=setup(t,{authentication:'desktop',accountId:'example-account',tokenEnvironment:undefined,credentialHostId:'credential-host'},undefined,undefined,undefined,id=>id==='credential-host'?'disconnected':'connected');
 const pending=h.behavior.callAgentTool('oxi_op_store',{title:'Example'},context);await setImmediate();
 const unexpected=h.inspection.pendingInteractions[0];if(unexpected)h.behavior.cancelInteraction(unexpected.id);
 const result=JSON.parse(await pending);
 assert.equal(result.completed,false);assert.equal(result.code,'credential_host_offline');
 assert.equal(h.inspection.pendingInteractions.length,0);assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
 const rows=JSON.parse((await h.behavior.runCli(['history'],context)).stdout);
 assert.equal(rows[0].state,'failed');assert.equal(rows[0].failureCode,'credential_host_offline');
});

test('host loss while a form is open stops submission before any credential host call',async t=>{
 let online=true;
 const h=setup(t,{},undefined,undefined,undefined,()=>online?'connected':'disconnected');
 const work=h.behavior.callAgentTool('oxi_op_store',{title:'Example'},context);await setImmediate();
 online=false;h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id,{password:'synthetic-value'});
 const result=JSON.parse(await work);assert.equal(result.code,'credential_host_offline');
 assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
 const row=JSON.parse((await h.behavior.runCli(['history'],context)).stdout)[0];assert.equal(row.state,'failed');assert(row.approvedAt);
});
test('diagnostics identify offline desktop dependency without forms or op calls',async t=>{
 const h=setup(t,{authentication:'desktop',accountId:'example-account',tokenEnvironment:undefined,credentialHostId:'credential-host'},undefined,undefined,undefined,id=>id==='credential-host'?'disconnected':'connected');
 const result=JSON.parse((await h.behavior.runCli(['diagnose'],context)).stdout);
 assert.equal(result.credentialHost.status,'disconnected');assert.equal(result.executionHost.status,'connected');assert.equal(result.credentialCalls,0);assert.equal(result.serviceTokenConfigured,false);
 assert.equal(h.inspection.pendingInteractions.length,0);assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
});

const desktop={authentication:'desktop',accountId:'example-account',tokenEnvironment:undefined,credentialHostId:'example-credential-host'};
function automationSetup(t,{hostStatus='connected',readerWritable=false,issue}={}){
 const h=setup(t,desktop,({method,input})=>{
  if(method==='issueServiceAccounts')return issue?issue(input):{vaultId:'automation-vault',vaultName:'Example workspace — Automation',accounts:input.accounts.map(a=>({profile:a.profile,token:'synthetic-'+a.profile+'-token',recovered:false}))};
  if(method==='probeScope')return {vaultIds:['automation-vault'],writable:input.serviceAccountToken==='synthetic-intake-token'||readerWritable};
  if(method==='verify')return {verified:true,cleaned:true};
  throw new Error('unexpected '+method);
 },undefined,undefined,hostStatus);
 return h;
}
const automateArgs=['automate','--project','target-project','--profile','default','--host','example-exec-host','--op-binary','/usr/bin/op'];
test('automatic project access is issued after one approval and proven from the execution host',async t=>{
 const h=automationSetup(t);
 await h.behavior.setSettings({routes:JSON.stringify([{...route,...desktop},{...route,...desktop,projectId:'target-project',vaultId:'target-default-vault'}])});
 const cancelled=h.behavior.runCli(automateArgs,context);await setImmediate();
 assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
 const form=h.inspection.pendingInteractions[0];
 assert.equal(form.timeoutMs,60_000);
 assert(form.payload.purpose.includes('read_items')&&form.payload.purpose.includes('90'));
 h.behavior.cancelInteraction(form.id);await cancelled;
 assert.equal(h.inspection.experimental_hostRpcCalls.length,0);
 const work=h.behavior.runCli(automateArgs,context);await setImmediate();
 h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id,{approved:true});
 const out=(await work).stdout;
 assert(!out.includes('synthetic'));
 const result=JSON.parse(out);
 assert.equal(result.configured,true);assert.equal(result.readerWriteDenied,true);assert.equal(result.intakeVerified,true);
 const calls=h.inspection.experimental_hostRpcCalls;
 assert.deepEqual(calls[0].method,'issueServiceAccounts');assert.equal(calls[0].hostId,'example-credential-host');
 assert.equal(calls[0].input.backupVaultId,'target-default-vault');assert.equal(calls[0].input.expiresIn,'90d');
 assert.deepEqual(calls[0].input.accounts.map(a=>[a.profile,a.permissions.join(',')]),[['routine','read_items'],['intake','read_items,write_items']]);
 assert(calls.slice(1).every(c=>c.hostId==='example-exec-host'&&c.input.route.opBinary==='/usr/bin/op'&&c.input.route.authentication==='service-account'));
 const target={...context,projectId:'target-project'};
 const routine=JSON.parse((await h.behavior.runCli(['status','--profile','routine'],target)).stdout);
 assert.equal(routine.requireApproval,false);assert.equal(routine.vaultId,'automation-vault');assert.equal(routine.hostId,'example-exec-host');
 assert.equal(JSON.parse((await h.behavior.runCli(['status','--profile','intake'],target)).stdout).requireApproval,true);
 assert.equal(JSON.parse((await h.behavior.runCli(['diagnose','--profile','routine'],target)).stdout).serviceTokenConfigured,true);
 assert(!(await h.behavior.runCli(['history'],context)).stdout.includes('synthetic'));
 const before=calls.length;
 assert.equal((await h.behavior.runCli(automateArgs,context)).exitCode,1);
 assert.equal(h.inspection.experimental_hostRpcCalls.length,before);
});
test('a reader that can write is never activated as automatic access',async t=>{
 const h=automationSetup(t,{readerWritable:true});
 await h.behavior.setSettings({routes:JSON.stringify([{...route,...desktop},{...route,...desktop,projectId:'target-project',vaultId:'target-default-vault'}])});
 const work=h.behavior.runCli(automateArgs,context);await setImmediate();
 h.behavior.submitInteraction(h.inspection.pendingInteractions[0].id,{approved:true});
 assert.equal((await work).exitCode,1);
 assert.equal((await h.behavior.runCli(['status','--profile','routine'],{...context,projectId:'target-project'})).exitCode,1);
 assert.equal(JSON.parse((await h.behavior.runCli(['history'],context)).stdout).find(x=>x.kind==='automate').state,'needs-review');
});
test('automatic access setup needs an online execution host and an existing desktop project vault',async t=>{
 const offline=automationSetup(t,{hostStatus:id=>id==='example-exec-host'?'disconnected':'connected'});
 await offline.behavior.setSettings({routes:JSON.stringify([{...route,...desktop},{...route,...desktop,projectId:'target-project',vaultId:'target-default-vault'}])});
 assert.equal((await offline.behavior.runCli(automateArgs,context)).exitCode,1);
 assert.equal(offline.inspection.pendingInteractions.length,0);
 const missing=automationSetup(t);
 await missing.behavior.setSettings({routes:JSON.stringify([{...route,...desktop}])});
 assert.equal((await missing.behavior.runCli(automateArgs,context)).exitCode,1);
 const service=automationSetup(t);
 await service.behavior.setSettings({routes:JSON.stringify([route,{...route,...desktop,projectId:'target-project',vaultId:'target-default-vault'}])});
 assert.equal((await service.behavior.runCli(automateArgs,context)).exitCode,1);
 for(const h of [missing,service])assert.equal(h.inspection.experimental_hostRpcCalls.length+h.inspection.pendingInteractions.length,0);
});
