import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';

const fakeGithubApiUrl = new URL('./fake-github-api.ts', import.meta.url).href;
const fakeSecretFileUrl = new URL('./fake-secret-file.ts', import.meta.url)
  .href;
const fakeStoreUrl = new URL('./fake-store.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/(^|\/)github\/api(?:\.js)?$/u.test(specifier)) {
      return { shortCircuit: true, url: fakeGithubApiUrl };
    }
    if (/(^|\/)lib\/secret-file(?:\.js)?$/u.test(specifier)) {
      return { shortCircuit: true, url: fakeSecretFileUrl };
    }
    if (/(^|\/)store(?:\.js)?$/u.test(specifier)) {
      return { shortCircuit: true, url: fakeStoreUrl };
    }
    if (
      specifier.startsWith('.') &&
      (specifier.endsWith('.js') || !specifier.match(/\.[a-z]+$/i))
    ) {
      const sourceUrl = new URL(
        specifier.endsWith('.js')
          ? `${specifier.slice(0, -'.js'.length)}.ts`
          : `${specifier}.ts`,
        context.parentURL
      );
      if (existsSync(fileURLToPath(sourceUrl))) {
        return { shortCircuit: true, url: sourceUrl.href };
      }
    }
    return nextResolve(specifier, context);
  }
});

const { createWorkItemStore } = await import('../store.ts');
const plugin = (await import('../server.ts')).default;

export interface FakeCatalogEntry {
  id: string;
  bbProjectId: string;
  repos: string[];
  account?: string;
}

export interface FakeServer {
  rpc: Record<string, (input?: unknown) => Promise<unknown>> & {
    call(method: string, input?: unknown): Promise<unknown>;
  };
  cli(
    argv: string[],
    ctx?: Record<string, unknown>
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  store: ReturnType<typeof createWorkItemStore>;
  dispose(): Promise<void>;
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function githubItem(locator: string) {
  const [repo, number] = locator.split('#');
  return {
    repo,
    number: Number(number),
    kind: 'issue',
    title: `Issue ${locator}`,
    state: 'open',
    author: 'tester',
    labels: [],
    assignees: [],
    url: `https://github.com/${repo}/issues/${number}`,
    body: '',
    updatedAt: '2026-09-25T00:00:00.000Z'
  };
}

const DEFAULT_PROJECTS = [
  { id: 'proj_a', name: 'Project A' },
  { id: 'proj_b', name: 'Project B' },
  { id: 'proj_c', name: 'Project C' },
  { id: 'proj_x', name: 'Project X' }
];

export async function startServer(options: {
  catalog: FakeCatalogEntry[];
  projects?: { id: string; name: string }[];
  githubList?: (
    project: { repositories: { repo: string }[] },
    input: Record<string, unknown>
  ) => unknown;
  onGithubRepos?: (repos: string[]) => void;
}): Promise<FakeServer> {
  (globalThis as Record<string, unknown>).__oxiProjectsFakeGithub = {
    listProject: options.githubList,
    onRepos: options.onGithubRepos
  };
  const catalog = options.catalog.map(entry => ({
    id: entry.id,
    name: entry.id,
    bbProjectId: entry.bbProjectId,
    autopilotProject: null,
    repositories: entry.repos.map(repo => ({
      repo,
      account: entry.account ?? 'work'
    }))
  }));
  const projects = options.projects ?? DEFAULT_PROJECTS;
  const { bb, harness } = createFakePluginHost({
    pluginId: 'oxi-projects',
    settings: { projects: JSON.stringify(catalog) },
    sdk: {
      projects: {
        list: async () => projects
      },
      plugins: {
        getSettings: async () => {
          throw new Error('offline');
        }
      },
      hosts: {
        list: async () => []
      }
    }
  });
  await plugin(bb);
  const service = harness.runService('sync');
  const call = (method: string, input?: unknown) =>
    harness.callRpc(method, input);
  const rpc = new Proxy(
    { call },
    {
      get(target, property) {
        if (property === 'call') return target.call;
        return (input?: unknown) => target.call(String(property), input);
      }
    }
  ) as FakeServer['rpc'];
  const store = createWorkItemStore(bb);
  return {
    rpc,
    cli: (argv: string[], ctx: Record<string, unknown> = {}) =>
      harness.runCli(argv, ctx) as Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>,
    store,
    async dispose() {
      service.controller.abort();
      await service.done.catch(() => undefined);
      await harness.dispose();
    }
  };
}
