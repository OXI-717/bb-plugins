import * as real from '../lib/secret-file.ts';

function record(event: string): void {
  const global = globalThis as { __oxiProjectsOrder?: string[] };
  (global.__oxiProjectsOrder ??= []).push(event);
}

export async function writeSecretFile(
  ...args: Parameters<typeof real.writeSecretFile>
): Promise<void> {
  record('secret:set');
  return real.writeSecretFile(...args);
}

export async function deleteSecretFile(
  ...args: Parameters<typeof real.deleteSecretFile>
): Promise<void> {
  record('secret:clear');
  return real.deleteSecretFile(...args);
}
