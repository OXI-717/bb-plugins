import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  defaultBrowsePreferences,
  type BrowsePreferences
} from '../browse-preferences.ts';
import {
  FILTER_PRESET_LIMIT,
  FILTER_PRESET_STATE_JSON_MAX_LENGTH,
  filterPresetIdSchema,
  filterPresetNameSchema,
  filterPresetOrderSchema,
  filterPresetProjectIdSchema,
  filterPresetSchema,
  filterPresetStateSchema,
  normalizePresetName,
  resolvePresetOrder,
  serializeFilterPresetState
} from '../filter-presets.ts';

function githubPreferences() {
  return defaultBrowsePreferences({ provider: 'github' });
}

function maximumUtf8Preferences(): BrowsePreferences {
  const values = Array.from({ length: 100 }, (_, index) =>
    `${'界'.repeat(497)}${String(index).padStart(3, '0')}`
  );
  return {
    ...githubPreferences(),
    source: 'github' as const,
    view: 'kanban' as const,
    query: '界'.repeat(500),
    stateCategories: [
      'backlog',
      'todo',
      'in_progress',
      'done',
      'canceled'
    ],
    statuses: values,
    assignees: values,
    priorities: values,
    externalProjects: values,
    labels: values,
    collapsedGroups: Object.fromEntries(values.map(value => [value, true]))
  };
}

test('accepts a complete strict project browse preference snapshot', () => {
  const state = {
    ...githubPreferences(),
    query: 'security',
    view: 'kanban' as const,
    stateCategories: ['in_progress' as const],
    statuses: ['Review'],
    assignees: ['Mateo'],
    priorities: ['High'],
    externalProjects: ['Taskboard'],
    labels: ['backend'],
    collapsedGroups: { done: false }
  };
  const preset = filterPresetSchema.parse({
    id: 'fp_1',
    projectId: 'proj_alpha',
    name: 'My work',
    state,
    position: 0
  });

  assert.deepEqual(preset.state, state);
  assert.equal(preset.name, 'My work');
  assert.throws(() =>
    filterPresetStateSchema.parse({ ...state, unexpected: true })
  );
});

test('requires a project provider and matching source', () => {
  assert.throws(() =>
    filterPresetStateSchema.parse(defaultBrowsePreferences())
  );
  assert.throws(() =>
    filterPresetStateSchema.parse({
      ...githubPreferences(),
      source: 'linear'
    })
  );
  assert.equal(
    filterPresetStateSchema.parse({
      ...githubPreferences(),
      source: 'github'
    }).source,
    'github'
  );
});

test('bounds names, ids, positions, order size, and state fields', () => {
  const base = {
    id: 'fp_1',
    projectId: 'proj_alpha',
    name: 'My work',
    state: githubPreferences(),
    position: 0
  };
  assert.throws(() => filterPresetSchema.parse({ ...base, name: '   ' }));
  assert.throws(() =>
    filterPresetSchema.parse({ ...base, name: 'x'.repeat(61) })
  );
  assert.throws(() => filterPresetIdSchema.parse('x'.repeat(101)));
  assert.throws(() => filterPresetProjectIdSchema.parse('proj_'));
  assert.throws(() =>
    filterPresetSchema.parse({ ...base, position: FILTER_PRESET_LIMIT })
  );
  assert.throws(() =>
    filterPresetOrderSchema.parse(
      Array.from({ length: FILTER_PRESET_LIMIT + 1 }, (_, index) =>
        `fp_${index}`
      )
    )
  );
  assert.throws(() =>
    filterPresetStateSchema.parse({
      ...githubPreferences(),
      query: 'x'.repeat(501)
    })
  );
  assert.throws(() =>
    filterPresetStateSchema.parse({
      ...githubPreferences(),
      labels: Array.from({ length: 101 }, (_, index) => `label-${index}`)
    })
  );
});

test('rejects control characters in preset identity and state', () => {
  for (const control of ['\n', '\u0000', '\u0085', '\u202e', '\u2067']) {
    assert.throws(() => filterPresetNameSchema.parse(`left${control}right`));
    assert.throws(() => filterPresetIdSchema.parse(`fp_${control}`));
    assert.throws(() =>
      filterPresetStateSchema.parse({
        ...githubPreferences(),
        assignees: [`left${control}right`]
      })
    );
  }
  assert.throws(() =>
    filterPresetStateSchema.parse({
      ...githubPreferences(),
      assignees: ['Mateo\n']
    })
  );
});

test('rejects oversized adversarial containers before inspecting elements', () => {
  let indexedReads = 0;
  const oversizedLabels = new Proxy([] as string[], {
    get(target, property, receiver) {
      if (property === 'length') return 1_000_000;
      if (typeof property === 'string' && /^\d+$/u.test(property)) {
        indexedReads += 1;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(() =>
    filterPresetStateSchema.parse({
      ...githubPreferences(),
      labels: oversizedLabels
    })
  );
  assert.equal(indexedReads, 0);

  let queryGetterCalled = false;
  const accessorState = { ...githubPreferences() };
  Object.defineProperty(accessorState, 'query', {
    enumerable: true,
    get() {
      queryGetterCalled = true;
      return 'unsafe';
    }
  });
  assert.throws(() => filterPresetStateSchema.parse(accessorState));
  assert.equal(queryGetterCalled, false);

  let orderIndexedReads = 0;
  const oversizedOrder = new Proxy([] as string[], {
    get(target, property, receiver) {
      if (property === 'length') return 100_000;
      if (typeof property === 'string' && /^\d+$/u.test(property)) {
        orderIndexedReads += 1;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(() => filterPresetOrderSchema.parse(oversizedOrder));
  assert.equal(orderIndexedReads, 0);
});

test('accepts the maximum valid browse state inside the UTF-8 envelope', () => {
  const largestState = maximumUtf8Preferences();
  const largestSerialized = serializeFilterPresetState(largestState);
  const byteLength = new TextEncoder().encode(largestSerialized).byteLength;
  assert.ok(byteLength <= FILTER_PRESET_STATE_JSON_MAX_LENGTH);
  assert.ok(byteLength > 890_000);
  assert.deepEqual(filterPresetStateSchema.parse(largestState), largestState);
});

test('normalizes unique names without depending on locale', () => {
  assert.equal(normalizePresetName('  My Work '), 'my work');
  assert.equal(normalizePresetName('MY WORK'), normalizePresetName('my work'));
  assert.equal(normalizePresetName('\uff2d\uff59 \uff37\uff4f\uff52\uff4b'), 'my work');
  assert.equal(normalizePresetName('\u0130'), 'i\u0307');
  assert.equal(normalizePresetName('  \u0130S  '), 'i\u0307s');
  assert.equal(normalizePresetName('\u0130'.repeat(60)).length, 120);
});

test('resolves only exact preset order permutations', () => {
  assert.deepEqual(
    resolvePresetOrder(['a', 'b', 'c'], ['c', 'a', 'b']),
    ['c', 'a', 'b']
  );
  assert.throws(() => resolvePresetOrder(['a', 'b'], ['a']));
  assert.throws(() => resolvePresetOrder(['a', 'b'], ['a', 'z']));
  assert.throws(() => resolvePresetOrder(['a', 'b'], ['a', 'a']));
  assert.throws(() => resolvePresetOrder(['a', 'a'], ['a', 'a']));
});
