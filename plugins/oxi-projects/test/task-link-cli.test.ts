import assert from 'node:assert/strict';
import {test} from 'node:test';
import {startServer, githubItem} from './fake-bb.ts';

test('show emits a project-scoped task link only after a successful read', async () => {
  const { cli, rpc, dispose } = await startServer({
    catalog: [{id:'e1',bbProjectId:'proj_a',repos:['o/r']}],
    githubList: async () => [githubItem('o/r#1')]
  });
  const globals = globalThis as unknown as {__oxiProjectsFakeGithub: {readItem?: () => unknown}};
  globals.__oxiProjectsFakeGithub.readItem = () => ({
    repo:'o/r',number:1,title:'Task',state:'open',author:'tester',labels:[],assignees:[],
    url:'https://github.com/o/r/issues/1',body:'',updatedAt:'2026-10-05T00:00:00Z',comments:[]
  });
  try {
    await rpc.refresh({projectId:'proj_a',source:'github'});
    const result = await cli(['show','github','o/r#1','--project','proj_a','--json']);
    assert.equal(result.exitCode, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.item.bbProjectId, 'proj_a');
    assert.match(output.projectLink, /^::project-task\{project="proj_a" source="github" locator="o%2Fr%231"/);
    const missing = await cli(['show','linear','ABC-1','--project','proj_a','--json']);
    assert.equal(missing.exitCode, 1);
    assert.doesNotMatch(missing.stdout ?? '', /project-task/);
  } finally {await dispose();}
});
