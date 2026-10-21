import { describe, it, expect } from 'vitest';
import { planSweep, planPrune, DAY, type Snapshot, type Config } from './policy.js';
const now=100*DAY;
const config: Config={inactivityDays:14,sinceInstallAt:DAY,keepThreadIds:[],detachActiveDescendants:false};
const t=(id:string, extra:Partial<Snapshot>={}):Snapshot=>({id,title:id,parentThreadId:null,lifecycleOwnerThreadId:null,sourceThreadId:null,visibility:'visible',latestAttentionAt:70*DAY,status:'idle',pinnedAt:null,workspace:'clean',...extra});
const ids=(p:ReturnType<typeof planSweep>)=>p.actions.map(a=>a.rootId);
describe('archive policy',()=>{
 it('uses inclusive 14 day cutoff, preserves install backlog',()=>{
  expect(ids(planSweep([t('edge',{latestAttentionAt:86*DAY}),t('fresh',{latestAttentionAt:86*DAY+1}),t('backlog',{latestAttentionAt:0})],config,now))).toEqual(['edge']);
 });
 it.each(['parentThreadId','lifecycleOwnerThreadId'] as const)('recent descendant through %s protects root',key=>{
  expect(ids(planSweep([t('root'),t('child',{[key]:'root',latestAttentionAt:now})],config,now))).toEqual([]);
 });
 it.each([{pinnedAt:1},{title:'📌 permanent'},{id:'keep'},{workspace:'dirty'},{workspace:'unknown'}] as Partial<Snapshot>[])('protects every member and ancestor: %j',extra=>{
  expect(ids(planSweep([t('root'),t('child',{parentThreadId:'root',...extra})],{...config,keepThreadIds:['keep']},now))).toEqual([]);
 });
 it('archives a quiet multi-level tree once',()=>{
  expect(planSweep([t('r'),t('c',{parentThreadId:'r'}),t('g',{lifecycleOwnerThreadId:'c'})],config,now).actions[0].archiveIds).toEqual(['r','c','g']);
 });
 it('detaches recent parent-linked branch with its descendants',()=>{
  const p=planSweep([t('r'),t('c',{parentThreadId:'r',latestAttentionAt:now}),t('g',{parentThreadId:'c'})],{...config,detachActiveDescendants:true},now);
  expect(p.actions[0]).toEqual({rootId:'r',detachIds:['c'],archiveIds:['r']});
 });
 it('cannot detach immutable owner or hidden source dependencies',()=>{
  for(const extra of [{lifecycleOwnerThreadId:'r'}, {sourceThreadId:'r',visibility:'hidden' as const}]){
   const p=planSweep([t('r'),t('c',{...extra,latestAttentionAt:now})],{...config,detachActiveDescendants:true},now);
   expect(p.actions).toEqual([]); expect(p.blocked.length).toBeGreaterThan(0);
  }
 });
 it('detects cycles and dangling references without archiving',()=>{
  expect(ids(planSweep([t('a',{parentThreadId:'b'}),t('b',{parentThreadId:'a'})],config,now))).toEqual([]);
  expect(ids(planSweep([t('a',{parentThreadId:'missing'})],config,now))).toEqual([]);
 });
 it('queued work and waiting interactions protect ancestors',()=>{
  for(const extra of [{busy:true},{status:'pending'}]) expect(ids(planSweep([t('r'),t('c',{parentThreadId:'r',...extra})],config,now))).toEqual([]);
 });
});
describe('prune',()=>{
 it('keeps target subtree, detaches target and active sibling, archives old ancestors and quiet branches',()=>{
  const p=planPrune([t('r'),t('mid',{parentThreadId:'r'}),t('keep',{parentThreadId:'mid',latestAttentionAt:now}),t('child',{parentThreadId:'keep'}),t('side',{parentThreadId:'r'}),t('active',{parentThreadId:'r',latestAttentionAt:now})],config,now,'keep');
  expect(p.detachIds).toContain('keep');expect(p.actions[0].archiveIds).toEqual(['r','mid','side']);expect(p.actions[0].detachIds).toContain('active');
 });
 it('explicit prune may handle pre-install backlog',()=>{
  expect(planPrune([t('r',{latestAttentionAt:0}),t('k',{parentThreadId:'r'})],config,now,'k').actions[0].rootId).toBe('r');
 });
 it('blocks immutable lifecycle owner without partial detach',()=>{
  const p=planPrune([t('r'),t('k',{parentThreadId:'r',lifecycleOwnerThreadId:'r'})],config,now,'k');
  expect(p.actions).toEqual([]);expect(p.detachIds).toEqual([]);expect(p.blocked.join()).toContain('lifecycle');
 });
 it('preserves pinned old ancestor',()=>{
  expect(planPrune([t('r',{pinnedAt:1}),t('k',{parentThreadId:'r'})],config,now,'k').actions).toEqual([]);
 });
});
