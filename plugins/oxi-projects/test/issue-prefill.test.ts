import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issuePrefillFromPrompt } from '../issue-prefill.ts';

test('turns the original composer prompt into an editable issue prefill', () => {
  assert.deepEqual(
    issuePrefillFromPrompt('\n  ## Fix the task title  \n\nKeep the full context.  '),
    {
      title: 'Fix the task title',
      description: '## Fix the task title  \n\nKeep the full context.'
    }
  );
});

test('bounds the title while retaining the complete trimmed description', () => {
  const title = `# ${'x'.repeat(140)}`;
  const prompt = `${title}\n\nAcceptance criteria stay here.`;
  const prefill = issuePrefillFromPrompt(prompt);

  assert.equal(prefill.title, 'x'.repeat(120));
  assert.equal(prefill.description, prompt);
});

test('keeps an empty prompt deterministic', () => {
  assert.deepEqual(issuePrefillFromPrompt(' \n '), {
    title: '',
    description: ''
  });
});
