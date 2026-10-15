function unquoteJqlValue(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(?:"(?<double>[^"]+)"|'(?<single>[^']+)'|(?<plain>[^\s,]+))$/u.exec(
    trimmed
  );
  return (
    quoted?.groups?.double ??
    quoted?.groups?.single ??
    quoted?.groups?.plain ??
    ''
  ).trim();
}

export function jiraProjectKeysFromJql(jql: string): string[] {
  const keys = new Set<string>();
  for (const match of jql.matchAll(
    /\bproject\s*=\s*("[^"]+"|'[^']+'|[A-Za-z][A-Za-z0-9_-]*)/giu
  )) {
    const key = unquoteJqlValue(match[1] ?? '');
    if (key && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) {
      keys.add(key.toUpperCase());
    }
  }
  for (const match of jql.matchAll(/\bproject\s+in\s*\(([^)]*)\)/giu)) {
    for (const value of (match[1] ?? '').split(',')) {
      const key = unquoteJqlValue(value);
      if (key && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(key)) {
        keys.add(key.toUpperCase());
      }
    }
  }
  return [...keys];
}
