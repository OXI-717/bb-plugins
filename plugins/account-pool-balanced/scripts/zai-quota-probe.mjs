import { pathToFileURL } from 'node:url';

// Standalone diagnostic only. No pool state, credential files, or configuration
// are read here. Node's --env-file loader supplies the one authorized credential.
export const ENDPOINT = 'https://api.z.ai/api/monitor/usage/quota/limit';
export const MAX_BYTES = 65_536;
const REQUEST_MS = 10_000;
const GLOBAL_MS = 25_000;
const NUMERIC_FIELDS = ['percentage', 'currentValue', 'usage', 'remaining', 'total', 'limit', 'used', 'unit', 'number'];
const RESET_FIELDS = ['nextResetTime', 'resetsAt'];
const SCHEMA_FIELDS = ['type', ...NUMERIC_FIELDS, ...RESET_FIELDS];
const QUOTA_FIELDS = NUMERIC_FIELDS.filter(name => name !== 'unit' && name !== 'number');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

function numeric(value, key) {
  // Numeric strings are deliberately not coerced. They may be arbitrary text
  // or identifiers, and no undocumented unit conversion is performed.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 &&
    value <= Number.MAX_SAFE_INTEGER && String(value) !== key ? value : null;
}

function reset(value, key) {
  if (String(value) === key) return null;
  let milliseconds;
  if (typeof value === 'number' && Number.isSafeInteger(value)) {
    milliseconds = value < 1e12 ? value * 1000 : value;
  } else if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) return null;
  } else return null;
  return milliseconds >= Date.UTC(2000, 0, 1) && milliseconds < Date.UTC(2100, 0, 1)
    ? new Date(milliseconds).toISOString() : null;
}

export function sanitizePayload(payload, key = '') {
  const root = record(payload);
  const data = record(root?.data);
  const limits = data?.limits;
  const schema = {
    root: kind(payload), code: kind(root?.code), success: kind(root?.success),
    error: kind(root?.error), data: kind(root?.data), limits: kind(limits), level: kind(data?.level),
  };
  const rejected = root !== null && (root.success === false || root.error != null ||
    (root.code != null && root.code !== 200 && root.code !== '200'));
  const rows = Array.isArray(limits) ? limits.slice(0, 8).map(value => {
    const row = record(value);
    if (row === null) return { schema: { row: kind(value) }, quota: {} };
    const shape = Object.fromEntries(SCHEMA_FIELDS.map(name => [name, kind(row[name])]));
    const quota = {};
    if (!rejected) {
      for (const name of NUMERIC_FIELDS) {
        const number = numeric(row[name], key);
        if (number !== null) quota[name] = number;
      }
      for (const name of RESET_FIELDS) {
        const timestamp = reset(row[name], key);
        if (timestamp !== null) quota[name] = timestamp;
      }
    }
    // Only known discriminants leave the process, never arbitrary type strings.
    const type = ['TOKENS_LIMIT', 'TIME_LIMIT', 'CREDIT_LIMIT'].includes(row.type) ? row.type : 'other';
    return { type, schema: shape, quota };
  }) : [];
  const level = typeof data?.level === 'string' && data.level !== key ? data.level.toLowerCase() : null;
  return { classification: rejected ? 'application_error'
    : rows.some(row => QUOTA_FIELDS.some(name => Object.hasOwn(row.quota, name))) ? 'quota_fields_observed' : 'no_supported_quota_fields',
  level: !rejected && ['lite', 'pro', 'max'].includes(level) ? level : null,
  schema, rows, truncatedRows: Array.isArray(limits) && limits.length > 8 };
}

async function readBounded(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return { classification: 'empty_body' };
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      signal.throwIfAborted();
      let abort;
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(new Error('request_cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      let chunk;
      try { chunk = await Promise.race([reader.read(), cancelled]); }
      finally { signal.removeEventListener('abort', abort); }
      const { done, value } = chunk;
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) return { classification: 'response_too_large' };
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return { payload: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }; }
    catch { return { classification: 'invalid_json' }; }
  } finally {
    // Never print cancellation/network exceptions, which may contain upstream text.
    void reader.cancel().catch(() => {});
  }
}

export async function runProbe({ key, mode = 'compare', fetchImpl = globalThis.fetch, signal = AbortSignal.timeout(GLOBAL_MS) }) {
  if (mode !== 'compare' && mode !== 'bearer-only') return { classification: 'arguments_not_supported', results: [] };
  if (typeof key !== 'string' || key.length === 0 || key.length > 4096 || /[\r\n]/.test(key)) {
    return { classification: 'credential_unavailable', results: [] };
  }
  const results = [];
  for (const authorization of mode === 'bearer-only' ? ['bearer'] : ['direct', 'bearer']) {
    if (signal.aborted) { results.push({ authorization, httpStatus: null, classification: 'global_timeout' }); break; }
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]);
    let httpStatus = null;
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'GET', redirect: 'error', signal: requestSignal,
        headers: { authorization: authorization === 'direct' ? key : `Bearer ${key}`, accept: 'application/json' },
      });
      httpStatus = response.status;
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        results.push({ authorization, httpStatus, classification: 'http_error' });
        continue;
      }
      const body = await readBounded(response, requestSignal);
      results.push({ authorization, httpStatus, ...(Object.hasOwn(body, 'payload')
        ? sanitizePayload(body.payload, key) : body) });
    } catch {
      results.push({ authorization, httpStatus, classification: signal.aborted ? 'global_timeout'
        : requestSignal.aborted ? 'request_timeout' : 'network_or_redirect_error' });
    }
  }
  return { classification: 'probe_finished', results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let outputQueued = false;
  // Retain the hard deadline until stdout has drained AND the process exits.
  // Aborting fetch does not guarantee that every transport handle has closed.
  const deadline = setTimeout(() => {
    if (!outputQueued) process.stdout.write(`${JSON.stringify({ classification: 'global_timeout', results: [] })}\n`);
    process.exit(124);
  }, GLOBAL_MS);
  const finish = (result, code) => {
    outputQueued = true;
    process.stdout.write(`${JSON.stringify(result)}\n`, error => {
      clearTimeout(deadline);
      process.exit(error ? 1 : code);
    });
  };
  const mode = process.argv.length === 2 ? 'compare'
    : process.argv.length === 3 && process.argv[2] === '--bearer-only' ? 'bearer-only' : null;
  if (mode === null) {
    finish({ classification: 'arguments_not_supported', results: [] }, 2);
  } else {
    try {
      const result = await runProbe({ key: process.env.ZAI_API_KEY, mode });
      finish(result, result.classification === 'credential_unavailable' ? 2 : 0);
    } catch {
      finish({ classification: 'probe_failed', results: [] }, 1);
    }
  }
}
