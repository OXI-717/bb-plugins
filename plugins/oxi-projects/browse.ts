import type {
  WorkItem,
  WorkStateCategory,
  WorkStatusOption
} from './contract.js';

export const UNASSIGNED_ASSIGNEE_FILTER = '__taskboard_unassigned__';
export const NO_PRIORITY_FILTER = '__taskboard_no_priority__';
export const NO_PROJECT_FILTER = '__taskboard_no_project__';
export const NO_LABELS_FILTER = '__taskboard_no_labels__';

export const DEFAULT_WORKFLOW_STATUS_ORDER: readonly string[] = [
  'Backlog',
  'Todo',
  'In Progress',
  'In Review',
  'QA',
  'Ready for Release',
  'Blocked',
  'Duplicate',
  'Done',
  'Canceled'
];

export interface FilterOption {
  value: string;
  label: string;
}

export type AssigneeFilterOption = FilterOption;

export const ASSIGNEE_AVATAR_TONES = [
  'violet',
  'blue',
  'teal',
  'amber',
  'rose',
  'slate'
] as const;
export type AssigneeAvatarTone = (typeof ASSIGNEE_AVATAR_TONES)[number];

export interface AssigneeAvatarIdentity {
  initials: string;
  tone: AssigneeAvatarTone;
}

export function assigneeAvatarIdentity(name: string): AssigneeAvatarIdentity {
  const normalized = name
    .normalize('NFKC')
    .trim()
    .replace(/\s+/gu, ' ');
  const initials =
    normalized
      .split(' ')
      .flatMap(token => {
        const character = Array.from(token).find(value =>
          /[\p{L}\p{N}]/u.test(value)
        );
        return character ? [character] : [];
      })
      .slice(0, 2)
      .map(character => Array.from(character.toUpperCase())[0] ?? '')
      .join('') || '?';
  let hash = 2166136261;
  for (const character of normalized.toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return {
    initials,
    tone:
      ASSIGNEE_AVATAR_TONES[
        (hash >>> 0) % ASSIGNEE_AVATAR_TONES.length
      ]!
  };
}

export interface WorkItemAttributeFilters {
  statuses: readonly string[];
  assignees: readonly string[];
  priorities: readonly string[];
  projects: readonly string[];
  labels: readonly string[];
}

export interface WorkflowStatus {
  name: string;
  category: WorkStateCategory;
}

export interface WorkflowStatusGroup extends WorkflowStatus {
  key: string;
  items: WorkItem[];
}

export interface WorkflowStatusLane extends WorkflowStatus {
  key: string;
}

const FALLBACK_WORKFLOW_RANK: Readonly<Record<WorkStateCategory, number>> = {
  in_progress: 0,
  todo: 1,
  backlog: 2,
  done: 3,
  canceled: 4
};

const FALLBACK_STATUS_LABEL: Readonly<Record<WorkStateCategory, string>> = {
  in_progress: 'In progress',
  todo: 'Todo',
  backlog: 'Backlog',
  done: 'Done',
  canceled: 'Canceled'
};

const PROVIDER_STATUS_ANCHORS: Readonly<
  Record<WorkStateCategory, readonly string[]>
> = {
  in_progress: ['in review', 'in progress', 'blocked'],
  todo: ['blocked', 'todo'],
  backlog: ['backlog'],
  done: ['done'],
  canceled: []
};

function normalizedValue(value: string): string {
  return value
    .trim()
    .replaceAll(/[_-]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .toLocaleLowerCase();
}

function normalizedStatus(value: string): string {
  const normalized = normalizedValue(value);
  return normalized === 'to do' ? 'todo' : normalized;
}

export const WORKFLOW_STATUS_TONES = [
  'review',
  'progress',
  'blocked',
  'qa',
  'todo',
  'duplicate',
  'triage',
  'backlog',
  'done',
  'canceled'
] as const;
export type WorkflowStatusTone = (typeof WORKFLOW_STATUS_TONES)[number];

const EXACT_STATUS_TONES = new Map<string, WorkflowStatusTone>([
  ['in review', 'review'],
  ['review', 'review'],
  ['in progress', 'progress'],
  ['started', 'progress'],
  ['blocked', 'blocked'],
  ['paused', 'blocked'],
  ['qa', 'qa'],
  ['quality assurance', 'qa'],
  ['todo', 'todo'],
  ['unstarted', 'todo'],
  ['duplicate', 'duplicate'],
  ['triage', 'triage'],
  ['backlog', 'backlog'],
  ['done', 'done'],
  ['completed', 'done'],
  ['closed', 'done'],
  ['canceled', 'canceled'],
  ['cancelled', 'canceled']
]);

export function workflowStatusTone(
  name: string,
  category: WorkStateCategory
): WorkflowStatusTone {
  const normalized = normalizedStatus(name);
  const exact = EXACT_STATUS_TONES.get(normalized);
  if (exact) return exact;

  let hash = 0;
  for (const character of `${category}:${normalized}`) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return WORKFLOW_STATUS_TONES[hash % WORKFLOW_STATUS_TONES.length]!;
}

function workflowRank(
  status: WorkflowStatus,
  statusOrder: readonly string[]
): number {
  const normalizedOrder = statusOrder.map(normalizedStatus);
  const exactRank = normalizedOrder.indexOf(normalizedStatus(status.name));
  if (exactRank >= 0) return exactRank;

  let categoryAnchor = -1;
  for (const [index, name] of normalizedOrder.entries()) {
    if (PROVIDER_STATUS_ANCHORS[status.category].includes(name)) {
      categoryAnchor = index;
    }
  }
  if (categoryAnchor >= 0) return categoryAnchor + 0.5;

  return statusOrder.length + FALLBACK_WORKFLOW_RANK[status.category];
}

export function compareWorkflowStatuses(
  left: WorkflowStatus,
  right: WorkflowStatus,
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): number {
  return (
    workflowRank(left, statusOrder) - workflowRank(right, statusOrder) ||
    left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }) ||
    left.name.localeCompare(right.name)
  );
}

export function sortWorkItemsByWorkflow(
  items: readonly WorkItem[],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): WorkItem[] {
  return [...items].sort((left, right) =>
    compareWorkflowStatuses(
      { name: left.status, category: left.stateCategory },
      { name: right.status, category: right.stateCategory },
      statusOrder
    )
  );
}

export function workflowStatusGroups(
  items: readonly WorkItem[],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): WorkflowStatusGroup[] {
  const groups = new Map<string, WorkflowStatusGroup>();
  for (const item of items) {
    const name = item.status.trim() || FALLBACK_STATUS_LABEL[item.stateCategory];
    const key = `${item.stateCategory}:${normalizedStatus(name)}`;
    const group = groups.get(key);
    if (group) {
      group.items.push(item);
    } else {
      groups.set(key, {
        key,
        name,
        category: item.stateCategory,
        items: [item]
      });
    }
  }
  return [...groups.values()].sort((left, right) =>
    compareWorkflowStatuses(left, right, statusOrder)
  );
}

export function workflowStatusLaneKey(
  name: string,
  category: WorkStateCategory
): string {
  return `${category}:${normalizedStatus(name)}`;
}

export function workflowStatusLanes(
  items: readonly WorkItem[],
  discovered: readonly WorkStatusOption[],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): WorkflowStatusLane[] {
  const lanes = new Map<string, WorkflowStatusLane>();
  for (const group of workflowStatusGroups(items, statusOrder)) {
    const key = workflowStatusLaneKey(group.name, group.category);
    lanes.set(key, {
      key,
      name: group.name,
      category: group.category
    });
  }
  for (const status of discovered) {
    const key = workflowStatusLaneKey(status.name, status.stateCategory);
    if (lanes.has(key)) continue;
    lanes.set(key, {
      key,
      name: status.name,
      category: status.stateCategory
    });
  }
  return [...lanes.values()].sort((left, right) =>
    compareWorkflowStatuses(left, right, statusOrder)
  );
}

function normalizedOptionalValue(
  value: string | null,
  emptyNames: RegExp
): string | null {
  const normalized = value?.trim().replaceAll(/\s+/gu, ' ') ?? '';
  if (!normalized || emptyNames.test(normalized)) return null;
  return normalized;
}

function normalizedAssignee(value: string | null): string | null {
  return normalizedOptionalValue(value, /^(?:none|unassigned)$/iu);
}

function normalizedPriority(value: string | null): string | null {
  return normalizedOptionalValue(value, /^(?:none|no priority)$/iu);
}

function normalizedProject(value: string | null): string | null {
  return normalizedOptionalValue(value, /^(?:none|no project)$/iu);
}

export function filterOptionIdentity(value: string): string {
  return value.toLocaleLowerCase();
}

export function canonicalizeSelectedFilterOptions(
  selected: readonly string[],
  options: readonly FilterOption[]
): string[] {
  const canonicalValues = new Map<string, string>();
  for (const option of options) {
    const identity = filterOptionIdentity(option.value);
    if (!canonicalValues.has(identity)) {
      canonicalValues.set(identity, option.value);
    }
  }

  const seen = new Set<string>();
  const canonicalized: string[] = [];
  for (const value of selected) {
    const identity = filterOptionIdentity(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    canonicalized.push(canonicalValues.get(identity) ?? value);
  }
  return canonicalized;
}

export function isFilterOptionSelected(
  selected: readonly string[],
  optionValue: string
): boolean {
  const identity = filterOptionIdentity(optionValue);
  return selected.some(value => filterOptionIdentity(value) === identity);
}

export function toggleFilterOptionSelection(
  selected: readonly string[],
  optionValue: string
): string[] {
  const identity = filterOptionIdentity(optionValue);
  const remaining = selected.filter(
    value => filterOptionIdentity(value) !== identity
  );
  return remaining.length === selected.length
    ? [...selected, optionValue]
    : remaining;
}

function singleValueFilterOptions(
  values: readonly (string | null)[],
  selected: readonly string[],
  normalize: (value: string | null) => string | null,
  emptyToken?: string,
  emptyLabel?: string
): FilterOption[] {
  const options = new Map<string, FilterOption>();
  let hasEmpty = false;
  for (const value of values) {
    const normalized = normalize(value);
    if (!normalized) {
      hasEmpty = true;
      continue;
    }
    const identity = filterOptionIdentity(normalized);
    if (!options.has(identity)) {
      options.set(identity, { value: normalized, label: normalized });
    }
  }
  for (const value of selected) {
    if (emptyToken && value === emptyToken) {
      hasEmpty = true;
      continue;
    }
    const normalized = normalize(value);
    if (!normalized) continue;
    const identity = filterOptionIdentity(normalized);
    if (!options.has(identity)) {
      options.set(identity, { value: normalized, label: normalized });
    }
  }
  const sorted = [...options.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
  );
  if (hasEmpty && emptyToken && emptyLabel) {
    sorted.push({ value: emptyToken, label: emptyLabel });
  }
  return sorted;
}

export function statusFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = [],
  statusOrder: readonly string[] = DEFAULT_WORKFLOW_STATUS_ORDER
): FilterOption[] {
  const categories = new Map<string, WorkStateCategory>();
  for (const item of items) {
    categories.set(
      filterOptionIdentity(item.status.trim()),
      item.stateCategory
    );
  }
  return singleValueFilterOptions(
    items.map(item => item.status),
    selected,
    value => normalizedOptionalValue(value, /^$/u)
  ).sort((left, right) =>
    compareWorkflowStatuses(
      {
        name: left.label,
        category: categories.get(filterOptionIdentity(left.value)) ?? 'todo'
      },
      {
        name: right.label,
        category: categories.get(filterOptionIdentity(right.value)) ?? 'todo'
      },
      statusOrder
    )
  );
}

export function assigneeFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): AssigneeFilterOption[] {
  return singleValueFilterOptions(
    items.map(item => item.assignee),
    selected,
    normalizedAssignee,
    UNASSIGNED_ASSIGNEE_FILTER,
    'Unassigned'
  );
}

function priorityRank(value: string): number {
  const normalized = normalizedValue(value);
  if (['urgent', 'critical', 'highest', 'blocker', 'p0'].includes(normalized)) {
    return 0;
  }
  if (['high', 'major', 'p1'].includes(normalized)) return 1;
  if (['medium', 'normal', 'moderate', 'p2'].includes(normalized)) return 2;
  if (['low', 'lowest', 'minor', 'trivial', 'p3', 'p4'].includes(normalized)) {
    return 3;
  }
  return 4;
}

export function priorityFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  return singleValueFilterOptions(
    items.map(item => item.priority),
    selected,
    normalizedPriority,
    NO_PRIORITY_FILTER,
    'No priority'
  ).sort(
    (left, right) =>
      (left.value === NO_PRIORITY_FILTER ? 5 : priorityRank(left.value)) -
        (right.value === NO_PRIORITY_FILTER ? 5 : priorityRank(right.value)) ||
      left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
  );
}

export function projectFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  return singleValueFilterOptions(
    items.map(item => item.project),
    selected,
    normalizedProject,
    NO_PROJECT_FILTER,
    'No project'
  );
}

export function labelFilterOptions(
  items: readonly WorkItem[],
  selected: readonly string[] = []
): FilterOption[] {
  const options = singleValueFilterOptions(
    items.flatMap(item => item.labels),
    selected.filter(label => label !== NO_LABELS_FILTER),
    value => normalizedOptionalValue(value, /^$/u)
  );
  if (
    (items.some(item => item.labels.every(label => !label.trim())) ||
      selected.includes(NO_LABELS_FILTER)) &&
    !options.some(option => option.value === NO_LABELS_FILTER)
  ) {
    options.push({ value: NO_LABELS_FILTER, label: 'No labels' });
  }
  return options;
}

function matchesSingleValueFilter(
  value: string | null,
  selected: readonly string[],
  normalize: (value: string | null) => string | null,
  emptyToken?: string
): boolean {
  if (selected.length === 0) return true;
  const normalized = normalize(value);
  if (!normalized) return emptyToken ? selected.includes(emptyToken) : false;
  const selectedValues = new Set(
    selected
      .filter(candidate => candidate !== emptyToken)
      .map(candidate => normalize(candidate))
      .filter((candidate): candidate is string => candidate !== null)
      .map(filterOptionIdentity)
  );
  return selectedValues.has(filterOptionIdentity(normalized));
}

export function filterWorkItemsByAssignee(
  items: readonly WorkItem[],
  selected: readonly string[]
): WorkItem[] {
  return items.filter(item =>
    matchesSingleValueFilter(
      item.assignee,
      selected,
      normalizedAssignee,
      UNASSIGNED_ASSIGNEE_FILTER
    )
  );
}

export function filterWorkItemsByAttributes(
  items: readonly WorkItem[],
  filters: WorkItemAttributeFilters
): WorkItem[] {
  const selectedLabels = new Set(
    filters.labels
      .filter(label => label !== NO_LABELS_FILTER)
      .map(filterOptionIdentity)
  );
  const includeNoLabels = filters.labels.includes(NO_LABELS_FILTER);

  return items.filter(item => {
    if (
      !matchesSingleValueFilter(
        item.status,
        filters.statuses,
        value => normalizedOptionalValue(value, /^$/u)
      ) ||
      !matchesSingleValueFilter(
        item.assignee,
        filters.assignees,
        normalizedAssignee,
        UNASSIGNED_ASSIGNEE_FILTER
      ) ||
      !matchesSingleValueFilter(
        item.priority,
        filters.priorities,
        normalizedPriority,
        NO_PRIORITY_FILTER
      ) ||
      !matchesSingleValueFilter(
        item.project,
        filters.projects,
        normalizedProject,
        NO_PROJECT_FILTER
      )
    ) {
      return false;
    }

    if (filters.labels.length === 0) return true;
    const labels = item.labels
      .map(label => label.trim())
      .filter(Boolean)
      .map(filterOptionIdentity);
    return labels.length === 0
      ? includeNoLabels
      : labels.some(label => selectedLabels.has(label));
  });
}
