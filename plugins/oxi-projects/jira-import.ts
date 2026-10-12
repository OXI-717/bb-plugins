import {readFile,realpath,stat} from 'node:fs/promises';
import {isAbsolute,sep} from 'node:path';
import {homedir} from 'node:os';

export interface JiraEnvValues {
  baseUrl: string;
  cloudId: string;
  email: string;
  token: string;
}

const MAX_ENV_BYTES = 64 * 1024;
const LINE = /^(?:export\s+)?([A-Z0-9_]+)=(.*)$/;
const SUBSTITUTION = /[$`]/;

type Field = keyof JiraEnvValues;

function wantedNames(prefix: string | undefined): Record<Field, string[]> {
  if (prefix) {
    return {
      baseUrl: [`${prefix}_SITE_URL`, `${prefix}_SITE`],
      cloudId: [`${prefix}_CLOUD_ID`],
      email: [`${prefix}_EMAIL`],
      token: [`${prefix}_TOKEN`, `${prefix}_API_TOKEN`]
    };
  }
  return {
    baseUrl: ['JIRA_SITE', 'JIRA_SITE_URL'],
    cloudId: ['JIRA_CLOUD_ID'],
    email: ['JIRA_EMAIL'],
    token: ['JIRA_API_TOKEN', 'JIRA_TOKEN']
  };
}

const REQUIRED = new Set<Field>(['baseUrl', 'email', 'token']);

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^(['"])(.*)\1$/, '$2');
}

export function parseJiraEnv(text: string, prefix?: string): JiraEnvValues {
  const wanted = wantedNames(prefix);
  const known = new Set(Object.values(wanted).flat());
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = LINE.exec(line.trim());
    if (!match || !known.has(match[1]!)) continue;
    const [, key, raw] = match;
    const value = stripQuotes(raw!);
    if (SUBSTITUTION.test(value)) {
      throw new Error(`${key}: подстановки не поддерживаются`);
    }
    values.set(key!, value);
  }
  const result = {} as Record<Field, string>;
  for (const field of Object.keys(wanted) as Field[]) {
    const names = wanted[field];
    const name = names.find(candidate => values.has(candidate)) ?? names[0]!;
    const value = values.get(name) ?? '';
    if (REQUIRED.has(field) && !value) {
      throw new Error(`В файле нет ${name}`);
    }
    result[field] = value;
  }
  if (result.baseUrl && !/^https?:\/\//i.test(result.baseUrl)) {
    result.baseUrl = `https://${result.baseUrl}`;
  }
  return result;
}

/**
 * Host side: читает env-файл как текст (без исполнения), максимум 64 КБ.
 * Путь — только абсолютный, realpath обязан остаться внутри
 * realpath($HOME); значения секретов не попадают в ошибки.
 */
export async function readJiraEnv(
  path: string,
  prefix: string | undefined,
  signal: AbortSignal,
  homeDir = homedir()
): Promise<JiraEnvValues> {
  if (!isAbsolute(path)) {
    throw new Error('Путь к env-файлу должен быть абсолютным внутри $HOME');
  }
  if (prefix !== undefined && !/^[A-Z0-9_]+$/.test(prefix)) {
    throw new Error('Префикс должен состоять из A-Z, 0-9 и _');
  }
  let resolved: string;
  let home: string;
  try {
    [resolved, home] = await Promise.all([
      realpath(path),
      realpath(homeDir)
    ]);
  } catch {
    throw new Error(`Не удалось прочитать ${path}`);
  }
  if (!resolved.startsWith(home + sep)) {
    throw new Error('Путь к env-файлу должен быть абсолютным внутри $HOME');
  }
  let text: string;
  try {
    if ((await stat(resolved)).size > MAX_ENV_BYTES) {
      throw new Error('too large');
    }
    text = await readFile(resolved, 'utf8');
  } catch {
    throw new Error(`Не удалось прочитать ${path}`);
  }
  return parseJiraEnv(text, prefix);
}
