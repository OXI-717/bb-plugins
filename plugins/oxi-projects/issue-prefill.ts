export interface IssuePrefill {
  title: string;
  description: string;
}

export function issuePrefillFromPrompt(prompt: string): IssuePrefill {
  const description = prompt.trim();
  const firstLine = description
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(Boolean);
  return {
    title: (firstLine ?? '')
      .replace(/^#{1,6}\s+/u, '')
      .slice(0, 120),
    description
  };
}
