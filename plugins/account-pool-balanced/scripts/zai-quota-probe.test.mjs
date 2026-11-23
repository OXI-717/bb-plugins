import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { ENDPOINT, MAX_BYTES, runProbe, sanitizePayload } from './zai-quota-probe.mjs';

const CANARY = 'synthetic-private-canary-DO-NOT-OUTPUT';
const payload = percentage => ({ code: 200, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage }] } });
const forbidden = output => {
  const text = JSON.stringify(output);
  for (const value of [CANARY, 'upstream-private-string', 'unknown-private-key', 'private-account-id']) {
    assert.equal(text.includes(value), false);
  }
};

test('uses only two sequential GETs to the fixed HTTPS quota endpoint, with no redirects or body', async () => {
  let active = 0;
  const calls = [];
  const result = await runProbe({ key: CANARY, fetchImpl: async (url, init) => {
    active++;
    assert.equal(active, 1);
    assert.equal(url, 'https://api.z.ai/api/monitor/usage/quota/limit');
    assert.equal(url, ENDPOINT);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.authorization, calls.length === 0 ? CANARY : `Bearer ${CANARY}`);
    calls.push(url);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return Response.json(payload(0));
  } });
  assert.equal(calls.length, 2);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].rows[0].quota.percentage, 0);
  forbidden(result);
});

for (const percentage of [0, 100]) {
  test(`reports actual numeric consumed percentage ${percentage} without an invented plan or reset`, () => {
    const result = sanitizePayload(payload(percentage), CANARY);
    assert.equal(result.classification, 'quota_fields_observed');
    assert.equal(result.rows[0].quota.percentage, percentage);
    assert.equal(Object.hasOwn(result.rows[0].quota, 'nextResetTime'), false);
    assert.equal(Object.hasOwn(result, 'plan'), false);
  });
}
for (const percentage of [null, undefined, '', '100', CANARY, true, {}, -1, Infinity, NaN]) {
  test(`does not invent a numeric quota from invalid value type ${typeof percentage}`, () => {
    const result = sanitizePayload(payload(percentage), CANARY);
    assert.equal(result.classification, 'no_supported_quota_fields');
    assert.deepEqual(result.rows[0].quota, { unit: 3 });
    forbidden(result);
  });
}
test('never reflects unknown keys, arbitrary types, account IDs, upstream messages or credential values', () => {
  const result = sanitizePayload({ code: 200, msg: CANARY, accountId: 'private-account-id',
    'unknown-private-key': CANARY, data: { plan: CANARY, limits: [{
      type: CANARY, unit: 3, percentage: CANARY, currentValue: 'upstream-private-string',
      nextResetTime: CANARY, unknown: CANARY, accountId: 'private-account-id',
    }] } }, CANARY);
  assert.equal(result.rows[0].type, 'other');
  forbidden(result);
});
test('does not reflect a numeric canary disguised as a quota field', () => {
  const result = sanitizePayload(payload(123456789), '123456789');
  assert.equal(JSON.stringify(result).includes('123456789'), false);
  assert.equal(result.classification, 'no_supported_quota_fields');
});
for (const value of [1793151000000, 1793151000, '2026-10-28T08:00:00Z']) {
  test(`validates a real reset timestamp of type ${typeof value}`, () => {
    const body = payload(0);
    body.data.limits[0].nextResetTime = value;
    const result = sanitizePayload(body, CANARY);
    assert.match(result.rows[0].quota.nextResetTime, /^2026-/);
  });
}
for (const value of [0, -1, 1e20, CANARY, '2026-02-30T00:00:00Z', '2026-10-28T08:00:00Z upstream-private-string']) {
  test(`drops invalid resets of type ${typeof value}`, () => {
    const body = payload(0);
    body.data.limits[0].nextResetTime = value;
    const result = sanitizePayload(body, CANARY);
    assert.equal(Object.hasOwn(result.rows[0].quota, 'nextResetTime'), false);
    forbidden(result);
  });
}
for (const error of [{ code: 401 }, { success: false }, { error: CANARY }]) {
  test('application error carries only safe shape and no quota measurement', () => {
    const result = sanitizePayload({ ...payload(0), ...error }, CANARY);
    assert.equal(result.classification, 'application_error');
    assert.deepEqual(result.rows[0].quota, {});
    forbidden(result);
  });
}
for (const status of [301, 401, 403, 429, 500]) {
  test(`HTTP ${status} exposes no raw body, headers or quota`, async () => {
    const result = await runProbe({ key: CANARY, fetchImpl: async () => new Response(CANARY, {
      status, headers: { 'x-private': CANARY, location: 'https://arbitrary.example/inference' },
    }) });
    assert.equal(result.results.length, 2);
    for (const row of result.results) assert.deepEqual(Object.keys(row), ['authorization', 'httpStatus', 'classification']);
    assert.equal(result.results[0].httpStatus, status);
    forbidden(result);
  });
}
test('invalid JSON and network/redirect exceptions never expose error text', async () => {
  let calls = 0;
  const result = await runProbe({ key: CANARY, fetchImpl: async () => {
    if (++calls === 1) return new Response(CANARY);
    throw new Error(`upstream-private-string ${CANARY}`);
  } });
  assert.equal(result.results[0].classification, 'invalid_json');
  assert.equal(result.results[1].classification, 'network_or_redirect_error');
  forbidden(result);
});
test('bounds response bytes and row count', async () => {
  const result = await runProbe({ key: CANARY, fetchImpl: async () => new Response('x'.repeat(MAX_BYTES + 1)) });
  assert.equal(result.results[0].classification, 'response_too_large');
  const shape = sanitizePayload({ data: { limits: Array.from({ length: 20 }, () => ({ percentage: 0 })) } });
  assert.equal(shape.rows.length, 8);
  assert.equal(shape.truncatedRows, true);
});
test('a global deadline stops subsequent requests, without retries or leaking the cause', async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await runProbe({ key: CANARY, signal: controller.signal, fetchImpl: async () => {
    calls++;
    controller.abort(new Error(CANARY));
    throw new Error(CANARY);
  } });
  assert.equal(calls, 1);
  assert.equal(result.results[0].classification, 'global_timeout');
  forbidden(result);
});
test('cancels a stalled body read within the deadline and never starts another GET', async () => {
  const controller = new AbortController();
  let calls = 0;
  const timer = setTimeout(() => controller.abort(new Error(CANARY)), 10);
  const result = await runProbe({ key: CANARY, signal: controller.signal, fetchImpl: async () => {
    calls++;
    return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }));
  } });
  clearTimeout(timer);
  assert.equal(calls, 1);
  assert.equal(result.results[0].classification, 'global_timeout');
  forbidden(result);
});
test('unknown credit structures remain unknown instead of invented zero or plan', () => {
  const result = sanitizePayload({ data: { credits: { remaining: 25 }, plan: CANARY } }, CANARY);
  assert.equal(result.classification, 'no_supported_quota_fields');
  assert.deepEqual(result.rows, []);
  forbidden(result);
});
for (const key of [undefined, '', '\r\n', 'x'.repeat(4097)]) {
  test('missing/invalid credential causes no network access', async () => {
    const result = await runProbe({ key, fetchImpl: () => { assert.fail('network was called'); } });
    assert.equal(result.classification, 'credential_unavailable');
  });
}
test('CLI rejects URL or inference arguments before any network, and emits only fixed JSON', () => {
  const env = { ...process.env, ZAI_API_KEY: CANARY };
  const path = new URL('./zai-quota-probe.mjs', import.meta.url);
  const child = spawnSync(process.execPath, [path.pathname, 'https://arbitrary.example/inference'], { env, encoding: 'utf8', timeout: 1000 });
  assert.equal(child.status, 2);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { classification: 'arguments_not_supported', results: [] });
  forbidden(child.stdout);
});
test('CLI drains its sanitized output and exits even with pending transport handles', () => {
  // Synthetic preload only for this test: no real endpoint or credential use.
  const preload = 'data:text/javascript,' + encodeURIComponent(
    `setInterval(() => {}, 1000); globalThis.fetch = async () => Response.json(${JSON.stringify(payload(0))});`,
  );
  const env = { ...process.env, ZAI_API_KEY: CANARY };
  delete env.NODE_OPTIONS;
  delete env.NODE_DEBUG;
  delete env.NODE_DEBUG_NATIVE;
  const path = new URL('./zai-quota-probe.mjs', import.meta.url);
  const child = spawnSync(process.execPath, ['--import', preload, path.pathname], { env, encoding: 'utf8', timeout: 1500 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0].rows[0].quota.percentage, 0);
  forbidden(result);
});
test('CLI enforces its hard global deadline even when a synthetic fetch ignores cancellation', { timeout: 30_000 }, () => {
  const preload = 'data:text/javascript,' + encodeURIComponent(
    'setInterval(() => {}, 1000); globalThis.fetch = async () => new Promise(() => {});',
  );
  const env = { ...process.env, ZAI_API_KEY: CANARY };
  delete env.NODE_OPTIONS;
  delete env.NODE_DEBUG;
  delete env.NODE_DEBUG_NATIVE;
  const path = new URL('./zai-quota-probe.mjs', import.meta.url);
  const child = spawnSync(process.execPath, ['--import', preload, path.pathname], { env, encoding: 'utf8', timeout: 28_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 124);
  assert.equal(child.stderr, '');
  assert.deepEqual(JSON.parse(child.stdout), { classification: 'global_timeout', results: [] });
  forbidden(child.stdout);
});

for (const type of ['CREDIT_LIMIT', 'TOKENS_LIMIT', 'TIME_LIMIT']) {
  test(`preserves only the explicitly allowed quota type ${type}`, () => {
    const body = payload(0);
    body.data.limits[0].type = type;
    assert.equal(sanitizePayload(body, CANARY).rows[0].type, type);
  });
}
for (const type of ['credit_limit', 'CREDIT_LIMIT extra', CANARY, 'UNKNOWN_LIMIT']) {
  test('unrecognized quota type remains other without emitting its string', () => {
    const body = payload(0);
    body.data.limits[0].type = type;
    const result = sanitizePayload(body, CANARY);
    assert.equal(result.rows[0].type, 'other');
    assert.equal(JSON.stringify(result).includes(type), false);
    forbidden(result);
  });
}
for (const level of ['lite', 'LITE', 'Lite', 'pro', 'PrO', 'max', 'MAX']) {
  test(`normalizes an explicit allowed level ${level}`, () => {
    const body = payload(0);
    body.data.level = level;
    const result = sanitizePayload(body, CANARY);
    assert.equal(result.level, level.toLowerCase());
    assert.equal(result.schema.level, 'string');
  });
}
for (const level of [undefined, null, 0, true, {}, CANARY, 'enterprise', ' lite ', 'pro-annual']) {
  test(`unknown level of type ${typeof level} stays null without raw text or inferred tier`, () => {
    const body = payload(100);
    body.data.level = level;
    const result = sanitizePayload(body, CANARY);
    assert.equal(result.level, null);
    forbidden(result);
  });
}
test('an application error cannot promote even a known level into a plan observation', () => {
  const body = { ...payload(0), success: false };
  body.data.level = 'lite';
  assert.equal(sanitizePayload(body, CANARY).level, null);
});
test('bearer-only mode makes exactly one fixed GET and preserves measured fields and bounded level', async () => {
  let calls = 0;
  const result = await runProbe({ key: CANARY, mode: 'bearer-only', fetchImpl: async (url, init) => {
    calls++;
    assert.equal(calls, 1);
    assert.equal(url, ENDPOINT);
    assert.equal(init.method, 'GET');
    assert.equal(init.redirect, 'error');
    assert.equal(init.body, undefined);
    assert.equal(init.headers.authorization, `Bearer ${CANARY}`);
    const body = payload(100);
    body.data.level = 'LITE';
    body.data.limits[0].type = 'CREDIT_LIMIT';
    return Response.json(body);
  } });
  assert.equal(calls, 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].authorization, 'bearer');
  assert.equal(result.results[0].level, 'lite');
  assert.equal(result.results[0].rows[0].type, 'CREDIT_LIMIT');
  assert.equal(result.results[0].rows[0].quota.percentage, 100);
  forbidden(result);
});
test('invalid programmatic mode makes no request', async () => {
  const result = await runProbe({ key: CANARY, mode: 'https://arbitrary.example', fetchImpl: () => assert.fail('network called') });
  assert.equal(result.classification, 'arguments_not_supported');
});
test('CLI static bearer-only flag produces one request; extra arguments are refused', () => {
  const body = payload(0);
  body.data.level = 'MAX';
  body.data.limits[0].type = 'CREDIT_LIMIT';
  const preload = 'data:text/javascript,' + encodeURIComponent(
    `let calls=0; globalThis.fetch=async(url,init)=>{if(++calls!==1||url!==${JSON.stringify(ENDPOINT)}||init.method!=='GET'||init.redirect!=='error'||init.headers.authorization!=='Bearer '+process.env.ZAI_API_KEY)process.exit(9);return Response.json(${JSON.stringify(body)});};`,
  );
  const env = { ...process.env, ZAI_API_KEY: CANARY };
  delete env.NODE_OPTIONS;
  delete env.NODE_DEBUG;
  delete env.NODE_DEBUG_NATIVE;
  const path = new URL('./zai-quota-probe.mjs', import.meta.url);
  const args = ['--import', preload, path.pathname, '--bearer-only'];
  const child = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 1500 });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].level, 'max');
  forbidden(result);
  const refused = spawnSync(process.execPath, [...args, '--url=https://arbitrary.example'], { env, encoding: 'utf8', timeout: 1500 });
  assert.equal(refused.status, 2);
  assert.deepEqual(JSON.parse(refused.stdout), { classification: 'arguments_not_supported', results: [] });
  forbidden(refused.stdout);
});
