import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';

export const linearMigrationContract = defineRpcContract({
  importLinearConnection: {
    input: z.object({
      projectId: z.string().min(1),
      teamKey: z.string().regex(/^[A-Za-z0-9_-]+$/),
      slot: z.enum(['apiKey', 'apiKey2', 'apiKey3', 'apiKey4']),
    }).strict(),
    output: z.object({ imported: z.boolean() }),
  },
});

// One-way runtime migration. The key is never returned, logged or sent to an agent.
// The source plugin's files remain untouched for rollback.
export async function withLegacyLinearKey(
  bb: BbPluginApi,
  slot: 'apiKey' | 'apiKey2' | 'apiKey3' | 'apiKey4',
  consume: (value: string) => Promise<void>,
) {
  let value: string;
  try {
    value = (await readFile(join(bb.server.experimental_dataDir, 'plugins', 'linear', 'secrets', slot), 'utf8')).trim();
  } catch {
    throw new Error('Сохранённый ключ Linear недоступен. Настрой подключение через форму проекта.');
  }
  if (!value) throw new Error('Сохранённый ключ Linear пуст.');
  await consume(value);
}
