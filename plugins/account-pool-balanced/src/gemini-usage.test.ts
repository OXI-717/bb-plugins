import {describe,it,expect} from 'vitest';
import {geminiSummaryWindows, geminiUsageObservation} from './gemini-usage.js';
describe('Gemini display observations',()=>{
 it('preserves model 0/100, optional resets, declared tier and absolute credits',()=>{
  const d=geminiUsageObservation({buckets:[{modelId:'gemini-test-pro',remainingFraction:0,resetTime:'2030-01-02T00:00:00Z'},{modelId:'gemini-test-flash',remainingFraction:1}]},{paidTier:{id:'g1-test-tier',name:'Synthetic plan',availableCredits:[{creditType:'GOOGLE_ONE_AI',creditAmount:'0'}]}},100);
  expect(d.models.map(m=>m.usedPercent)).toEqual([100,0]);expect(d.models[1]?.resetAt).toBeNull();expect(d.plan?.name).toBe('Synthetic plan');expect(d.credits).toBe('0');
 });
 it('keeps missing unknown without inferring fractions from amounts',()=>{
  const d=geminiUsageObservation({buckets:[{modelId:'gemini-test',remainingAmount:'100'},{modelId:'gemini-bad',remainingFraction:2}]},null,100);
  expect(d.models).toEqual([]);expect(d.plan).toBeNull();expect(d.credits).toBeNull();
 });
 it('does not retain unknown fields or credit types',()=>{
  const d=geminiUsageObservation({}, {currentTier:{id:'free-tier',availableCredits:[{creditType:'OTHER',creditAmount:'20'}]},secret:'synthetic-canary'},100);
  expect(d.credits).toBeNull();expect(JSON.stringify(d)).not.toContain('synthetic-canary');
 });
});

it.each([NaN,Infinity,-0.1,1.1,'0',null,undefined])('rejects invalid fraction %s',fraction=>{
 expect(geminiUsageObservation({buckets:[{modelId:'gemini-fixture',remainingFraction:fraction}]},null,100).models).toEqual([]);
});
it('uses declared current tier and g1 tier without inferring from balance',()=>{
 expect(geminiUsageObservation({}, {currentTier:{id:'current-fixture'}},100).plan?.id).toBe('current-fixture');
 expect(geminiUsageObservation({}, {g1Tier:'declared-fixture'},100).plan?.id).toBe('declared-fixture');
 expect(geminiUsageObservation({}, {paidTier:{availableCredits:[{creditType:'GOOGLE_ONE_AI',creditAmount:'12000'}]}},100).plan).toBeNull();
});

it.each(['-1','1.5','1e3','',undefined])('does not manufacture an absolute balance from %s',creditAmount=>{
 expect(geminiUsageObservation({}, {paidTier:{availableCredits:[{creditType:'GOOGLE_ONE_AI',creditAmount}]}},100).credits).toBeNull();
});

it("keeps the Gemini weekly value separate from third-party and Argon quotas", () => {
  const summary = geminiSummaryWindows({ groups: [
    { displayName: "Gemini 4 Argon", buckets: [{ bucketId: "gemini-weekly", remainingFraction: 1 }] },
    { buckets: [{ bucketId: "3p-weekly", remainingFraction: 1 }] },
    { buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0 }] },
  ] });
  expect(summary).toEqual([{ kind: "weekly", usedPercent: 100, resetAt: null }]);
});

it.each([
  [{ remainingFraction: "1" }],
  [{ remainingFraction: -0.1 }],
  [{ disabled: true }],
  [{ window: "5h" }],
  [{}, { remainingFraction: 0.75 }],
].map(overrides => ({ overrides })))("omits an invalid or ambiguous weekly bucket %#", ({ overrides }) => {
  const buckets = overrides.map(change => ({ bucketId: "gemini-weekly", remainingFraction: 0.5, ...change }));
  expect(geminiSummaryWindows({ groups: [{ buckets }] })).toEqual([]);
});
