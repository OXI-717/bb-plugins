interface FakeGithubProject {
  repositories: { repo: string }[];
}

interface FakeGithubControl {
  listProject?: (
    project: FakeGithubProject,
    input: Record<string, unknown>
  ) => unknown;
  readItem?: (...args: unknown[]) => unknown;
  onRepos?: (repos: string[]) => void;
}

function control(): FakeGithubControl {
  return (
    ((globalThis as Record<string, unknown>).__oxiProjectsFakeGithub as
      | FakeGithubControl
      | undefined) ?? {}
  );
}

export const makeRunner = () => async () => '';

export async function accounts(): Promise<string[]> {
  return ['work'];
}

export async function accountClient(): Promise<(...args: unknown[]) => Promise<string>> {
  return async () => '';
}

export async function listProject(
  project: FakeGithubProject,
  input: Record<string, unknown>
) {
  control().onRepos?.(project.repositories.map(entry => entry.repo));
  const result = await control().listProject?.(project, input);
  if (Array.isArray(result)) {
    return { items: result, errors: [], limited: [], at: 'now' };
  }
  return result ?? { items: [], errors: [], limited: [], at: 'now' };
}

export async function readItem(...args: unknown[]) {
  const impl = control().readItem;
  if (!impl) throw new Error('readItem is not implemented in the fake');
  return impl(...args);
}
