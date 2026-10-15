import { createWorkItemStore as real } from '../store.ts';

export function createWorkItemStore(
  ...args: Parameters<typeof real>
): ReturnType<typeof real> {
  const store = real(...args);
  const saveProjectSource = store.saveProjectSource.bind(store);
  store.saveProjectSource = input => {
    const global = globalThis as { __oxiProjectsOrder?: string[] };
    (global.__oxiProjectsOrder ??= []).push('store:save');
    return saveProjectSource(input);
  };
  return store;
}
