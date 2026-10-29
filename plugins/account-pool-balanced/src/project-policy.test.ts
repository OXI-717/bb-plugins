import { describe, expect, it } from 'vitest';
import { projectTier, projectRole } from './project-policy.js';
import { accountProjectsSchema } from './contracts.js';
const primary = { role: 'primary' as const };
const reserve = { role: 'reserve' as const };
const projects = { onlySelected: true, rules: [{ projectId: 'project-a', role: 'inherit' as const }] };
describe('project routing', () => {
 it('orders project primary, project reserve, global primary, global reserve', () => {
  expect([projectTier({...primary, projects}, 'project-a'), projectTier({...reserve, projects}, 'project-a'), projectTier(primary, 'project-a'), projectTier(reserve, 'project-a')]).toEqual([1,2,4,5]);
 });
 it('excludes scoped accounts in other or unknown projects', () => {
  expect(projectTier({...primary, projects}, 'project-b')).toBeNull();
  expect(projectTier({...primary, projects}, null)).toBeNull();
 });
 it('overrides default role while retaining access elsewhere', () => {
  const account = {...reserve, projects:{onlySelected:false, rules:[{projectId:'project-a',role:'primary' as const}]}};
  expect(projectRole(account,'project-a')).toBe('primary');
  expect(projectTier(account,'project-a')).toBe(1);
  expect(projectTier(account,'project-b')).toBe(5);
 });
 it('treats empty selection as unrestricted', () => {
  expect(projectTier({...primary, projects:{onlySelected:true,rules:[]}},null)).toBe(4);
 });
 it('keeps manual drain inside its project/general group and never overrides access', () => {
  expect(projectTier({...reserve,projects,drainOnce:true},'project-b')).toBeNull();
  expect(projectTier({...reserve,projects,drainOnce:true},null)).toBeNull();
  expect([projectTier({...reserve,projects,drainOnce:true},'project-a'),projectTier({...primary,projects},'project-a'),projectTier({...reserve,projects},'project-a'),projectTier({...reserve,drainOnce:true},'project-a'),projectTier(primary,'project-a'),projectTier(reserve,'project-a')]).toEqual([0,1,2,3,4,5]);
 });
 it('rejects duplicate project IDs and invalid roles', () => {
  expect(accountProjectsSchema.safeParse({onlySelected:true,rules:[...projects.rules,...projects.rules]}).success).toBe(false);
  expect(accountProjectsSchema.safeParse({onlySelected:false,rules:[{projectId:'a',role:'unknown'}]}).success).toBe(false);
 });
});
