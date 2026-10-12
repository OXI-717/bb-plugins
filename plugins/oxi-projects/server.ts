import {setupIntegrations} from './integrations-server.js';
import {taskLinkDirective, taskLinkInstructions} from './task-links.js';
import {setupChatWatch} from './chat-watch-server.js';
import {setupCatalog} from './catalog-server.js';
import {render as renderCatalog} from './catalog-contract.js';
import {readableWorkContext} from './work-context.js';
import {z} from 'zod';
import {rpcContract as autopilotWorkContract} from './autopilot/contract.js';
import {problemContext as autopilotProblemContext} from './autopilot/problems.js';
import {linearMigrationContract,withLegacyLinearKey} from "./linear-migration.js";
import {registerWorkBindings} from "./work-bindings.js";
import {readItem} from "./github/api.js";
import {setupWorkspace} from "./workspace-server.js";
import {
  PLUGIN_CLI_OUTPUT_MAX_BYTES,
  type BbPluginApi,
  type PluginRpcHandlers
} from '@get-bb/plugin-sdk';
import {
  FILTER_PRESET_STATE_JSON_MAX_LENGTH,
  bbProjectIdSchema,
  createIssueMetadataSchema,
  escapeExternalInlineText,
  escapeExternalJsonOutput,
  filterPresetStateSchema,
  filterPresetSummary,
  formatWorkItemContext,
  normalizePresetName,
  projectConfigMutationSchema,
  projectCredentialsInteractionResponseSchema,
  projectSourceConfigSchema,
  projectSourceMutationSchema,
  projectSourceSchema,
  sourceName,
  workSourceSchema,
  workStatusOptionSchema,
  taskboardRpcContract,
  type CreateIssueContext,
  type CreateIssueInput,
  type CreateIssueMetadata,
  type FilterPreset,
  type ProjectConfigMutation,
  type ProjectConfigView,
  type ProjectSource,
  type ProjectSourceConfig,
  type ProjectSourceMutation,
  type ProjectSourceView,
  type SecretMutation,
  type TrackerProject,
  type WorkItem,
  type WorkItemDetail,
  type WorkItemFilterField,
  type WorkSource,
  type WorkStatusOption,
  type WorkSourceStatus
} from './contract.js';
import { filterWorkItemsByAttributes } from './browse.js';
import {
  assertExpectedConnectorRevision,
  createSafeIssueMetadataFailure,
  reconcileIssueCreation
} from './create-issue.js';
import {
  createProjectCredentialVault,
  type CredentialSource
} from './credentials.js';
import {
  createGithubAdapter,
  githubReposForProject,
  githubStatusOutputSchema,
  loadGithubStatus
} from './sources/github.js';
import { createJiraAdapter } from './sources/jira.js';
import { jiraProjectKeysFromJql } from './sources/jira-scope.js';
import { createLinearAdapter } from './sources/linear.js';
import {
  withoutComments,
  type ExternalWorkItemCreateResult,
  type ExternalWorkItem,
  type ExternalWorkItemDetail,
  type WorkSourceAdapter
} from './sources/types.js';
import { createWorkItemStore } from './store.js';
import { cleanupLegacyIssueDraftHelpers } from './legacy-issue-draft-cleanup.js';

const SOURCES: readonly WorkSource[] = ['linear', 'github', 'jira'];
const CREDENTIAL_SOURCES: readonly CredentialSource[] = ['linear', 'jira'];
const SYNC_INTERVAL_MS = 5 * 60_000;
const KEEP_SECRET = { operation: 'keep' } as const;
const DEFAULT_JIRA_JQL =
  'assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC';
const SOURCE_TITLE: Record<WorkSource, string> = {
  jira: 'Jira',
  linear: 'Linear',
  github: 'GitHub Issues'
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatFilterPresetCliJson(value: unknown): string {
  const output = escapeExternalJsonOutput(JSON.stringify(value));
  if (new TextEncoder().encode(output).byteLength > PLUGIN_CLI_OUTPUT_MAX_BYTES) {
    throw new Error('Filter preset output exceeds the plugin CLI limit');
  }
  return output;
}

function scopedItem(projectId: string, item: ExternalWorkItem): WorkItem {
  return { bbProjectId: projectId, ...item };
}

function scopedItemDetail(
  projectId: string,
  item: ExternalWorkItemDetail
): WorkItemDetail {
  return { bbProjectId: projectId, ...item };
}

function mentionId(item: WorkItem): string {
  return `${item.bbProjectId}:${item.source}:${item.locator}`;
}

function parseMentionId(value: string): {
  projectId: string;
  source: WorkSource;
  locator: string;
} {
  const firstSeparator = value.indexOf(':');
  const secondSeparator = value.indexOf(':', firstSeparator + 1);
  const projectId = value.slice(0, firstSeparator);
  const source = value.slice(firstSeparator + 1, secondSeparator);
  const locator = value.slice(secondSeparator + 1);
  const parsedProjectId = bbProjectIdSchema.safeParse(projectId);
  const parsedSource = workSourceSchema.safeParse(source);
  if (
    !parsedProjectId.success ||
    !parsedSource.success ||
    !locator ||
    firstSeparator < 0 ||
    secondSeparator < 0
  ) {
    throw new Error('Invalid Taskboard mention');
  }
  return {
    projectId: parsedProjectId.data,
    source: parsedSource.data,
    locator
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true }
    );
  });
}

interface ParsedCliArguments {
  positionals: string[];
  projectId: string | undefined;
  source: string | undefined;
  query: string | undefined;
  linearTeam: string | undefined;
  jiraUrl: string | undefined;
  jiraEmail: string | undefined;
  jiraJql: string | undefined;
  jiraCloudId: string | undefined;
  disconnect: string | undefined;
  envPath: string | undefined;
  envPrefix: string | undefined;
  jql: string | undefined;
  statusId: string | undefined;
  preset: string | undefined;
  fromState: string | undefined;
  json: boolean;
  cached: boolean;
}

const CLI_OPTIONS_BY_COMMAND = new Map<string, ReadonlySet<string>>([
  ['status', new Set(['--project', '--json'])],
  [
    'list',
    new Set([
      '--project',
      '--source',
      '--query',
      '--preset',
      '--cached',
      '--json'
    ])
  ],
  ['show', new Set(['--project', '--json'])],
  ['refresh', new Set(['--project', '--json'])],
  ['transitions', new Set(['--project', '--json'])],
  ['move', new Set(['--project', '--status', '--json'])],
  [
    'config',
    new Set([
      '--project',
      '--source',
      '--linear-team',
      '--jira-url',
      '--jira-email',
      '--jira-jql',
      '--jira-cloud-id',
      '--disconnect',
      '--json'
    ])
  ],
  [
    'jira',
    new Set(['--project', '--env', '--prefix', '--jql', '--json'])
  ],
  ['credentials', new Set(['--project', '--json'])],
  ['presets', new Set(['--project', '--from-state', '--json'])]
]);

export function parseTaskboardCliArguments(
  command: string,
  argv: string[]
): ParsedCliArguments {
  const allowedOptions = CLI_OPTIONS_BY_COMMAND.get(command);
  if (!allowedOptions) throw new Error('Unknown bb project-work command');

  const positionals: string[] = [];
  const seenOptions = new Set<string>();
  let projectId: string | undefined;
  let source: string | undefined;
  let query: string | undefined;
  let linearTeam: string | undefined;
  let jiraUrl: string | undefined;
  let jiraEmail: string | undefined;
  let jiraJql: string | undefined;
  let jiraCloudId: string | undefined;
  let disconnect: string | undefined;
  let envPath: string | undefined;
  let envPrefix: string | undefined;
  let jql: string | undefined;
  let statusId: string | undefined;
  let preset: string | undefined;
  let fromState: string | undefined;
  let json = false;
  let cached = false;

  const valueAfter = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (
      value === undefined ||
      value.startsWith('--') ||
      (value.length === 0 &&
        ![
          '--linear-team',
          '--jira-url',
          '--jira-email',
          '--query'
        ].includes(flag))
    ) {
      throw new Error(`${flag} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    if (!allowedOptions.has(argument)) {
      throw new Error('Unsupported bb project-work option');
    }
    if (seenOptions.has(argument)) {
      throw new Error(`${argument} may only be provided once`);
    }
    seenOptions.add(argument);
    if (argument === '--project') {
      projectId = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--source') {
      source = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--query') {
      query = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--linear-team') {
      linearTeam = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--jira-url') {
      jiraUrl = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--jira-email') {
      jiraEmail = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--jira-jql') {
      jiraJql = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--jira-cloud-id') {
      jiraCloudId = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--disconnect') {
      disconnect = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--env') {
      envPath = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--prefix') {
      envPrefix = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--jql') {
      jql = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--status') {
      statusId = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--preset') {
      preset = valueAfter(argument, index);
      index += 1;
    } else if (argument === '--from-state') {
      fromState = valueAfter(argument, index);
      if (fromState.length > FILTER_PRESET_STATE_JSON_MAX_LENGTH) {
        throw new Error('--from-state is too large');
      }
      index += 1;
    } else if (argument === '--json') {
      json = true;
    } else if (argument === '--cached') {
      cached = true;
    }
  }

  if (
    command === 'presets' &&
    fromState !== undefined &&
    (positionals[0] ?? 'list') !== 'save'
  ) {
    throw new Error('--from-state is only valid with presets save');
  }

  return {
    positionals,
    projectId,
    source,
    query,
    linearTeam,
    jiraUrl,
    jiraEmail,
    jiraJql,
    jiraCloudId,
    disconnect,
    envPath,
    envPrefix,
    jql,
    statusId,
    preset,
    fromState,
    json,
    cached
  };
}

export function resolvePresetListSelection(
  preset: FilterPreset | undefined,
  explicitSource: WorkSource | undefined,
  explicitQuery: string | undefined,
  enabledFilters: readonly WorkItemFilterField[]
) {
  const enabled = new Set(enabledFilters);
  const presetSource =
    preset && preset.state.source !== 'all'
      ? preset.state.source
      : undefined;
  return {
    source: explicitSource ?? presetSource,
    query: explicitQuery ?? preset?.state.query,
    stateCategories:
      preset && enabled.has('state') ? preset.state.stateCategories : [],
    attributeFilters: preset
      ? {
          statuses: enabled.has('status') ? preset.state.statuses : [],
          assignees: enabled.has('assignee') ? preset.state.assignees : [],
          priorities: enabled.has('priority')
            ? preset.state.priorities
            : [],
          projects: enabled.has('project')
            ? preset.state.externalProjects
            : [],
          labels: enabled.has('labels') ? preset.state.labels : []
        }
      : null
  };
}

export function formatProjectSources(
  views: readonly ProjectSourceView[],
  githubRepos: readonly string[]
): string {
  if (views.length === 0) return 'Источники задач не подключены';
  return views
    .map(view => {
      if (view.source === 'jira') {
        const keys = jiraProjectKeysFromJql(view.jql).join(', ') || view.jql;
        let host = view.baseUrl;
        try {
          host = new URL(view.baseUrl).host;
        } catch {
          // Keep the raw value when it is not a URL.
        }
        const cloud = view.cloudId ? ` · cloudId ${view.cloudId.slice(0, 8)}` : '';
        return `Jira\t${keys} · ${host}${cloud} · токен ${view.credentialConfigured ? 'задан' : 'не задан'}`;
      }
      if (view.source === 'linear') {
        return `Linear\t${view.teamKey} · ключ ${view.credentialConfigured ? 'задан' : 'не задан'}`;
      }
      return `GitHub Issues\t${githubRepos.length} репо`;
    })
    .join('\n');
}

function formatCredentialStatus(config: ProjectConfigView): string {
  return [
    `Project\t${config.projectId}`,
    `Linear credential\t${config.linearCredentialConfigured ? 'configured' : 'not configured'}`,
    `Jira credential\t${config.jiraCredentialConfigured ? 'configured' : 'not configured'}`
  ].join('\n');
}

function credentialStatus(config: ProjectConfigView) {
  return {
    projectId: config.projectId,
    linearCredentialConfigured: config.linearCredentialConfigured,
    jiraCredentialConfigured: config.jiraCredentialConfigured
  };
}

function refreshedItemCount(
  statuses: WorkSourceStatus[],
  source: WorkSource | undefined
): number {
  return statuses
    .filter(entry => source === undefined || entry.source === source)
    .reduce((total, entry) => total + entry.itemCount, 0);
}

function parseGithubRepoFromRemote(
  value: string | null | undefined
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sshMatch =
    /^git@github\.com:(?<repo>[^/\s]+\/[^/\s]+?)(?:\.git)?$/iu.exec(trimmed);
  if (sshMatch?.groups?.repo) return sshMatch.groups.repo;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== 'github.com') return null;
    const path = url.pathname
      .replace(/^\/+|\/+$/gu, '')
      .replace(/\.git$/iu, '');
    return /^[^/\s]+\/[^/\s]+$/u.test(path) ? path : null;
  } catch {
    return null;
  }
}

export default async function plugin(bb: BbPluginApi) {
  bb.agents.configure(context => ({tools:[],skills:[],instructions:taskLinkInstructions(context.project.id)}));
  const integrations=setupIntegrations(bb);
  const workspace=await setupWorkspace(bb,integrations);
  const chatWatch=setupChatWatch(bb,()=>integrations.require('autopilot'));
  const catalog=setupCatalog(bb,workspace.read,()=>integrations.require('autopilot'));
  const store = createWorkItemStore(bb);
  const credentials = createProjectCredentialVault(bb);

  async function liveProjects() {
    return bb.sdk.projects.list({ includePersonal: true });
  }

  async function listProjects(): Promise<TrackerProject[]> {
    const projects = await liveProjects();
    return projects
      .map(project => ({ id: project.id, name: project.name }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
      );
  }

  async function projectById(projectId: string): Promise<TrackerProject> {
    const projects = await listProjects();
    const project = projects.find(entry => entry.id === projectId);
    if (!project) throw new Error('BB project was not found');
    return project;
  }

  async function assertProjectExists(projectId: string): Promise<void> {
    await projectById(projectId);
  }

  const resolvePresetByName = (
    projectId: string,
    name: string
  ): FilterPreset => {
    const presets = store.listFilterPresets(projectId);
    const normalized = normalizePresetName(name);
    const match = presets.find(
      candidate => normalizePresetName(candidate.name) === normalized
    );
    if (match) return match;
    const available = presets.map(candidate => candidate.name).join(', ');
    throw new Error(
      available
        ? `Unknown filter preset "${name}". Available: ${available}`
        : `Unknown filter preset "${name}". This project has no presets.`
    );
  };

  function publishFilterPresetsChanged(projectId: string): void {
    bb.realtime.publish('taskboard:presets-changed', { projectId });
  }

  async function assertPresetProviderIsCurrent(
    projectId: string,
    preset: FilterPreset
  ): Promise<void> {
    await waitForMutations(projectId, SOURCES);
    const provider = legacyProjectConfig(projectId).source;
    if (preset.state.provider !== provider) {
      const savedProvider = preset.state.provider
        ? sourceName(preset.state.provider)
        : 'an unknown provider';
      throw new Error(
        `Filter preset "${preset.name}" was saved for ${savedProvider} but this project now uses ${sourceName(provider)}`
      );
    }
  }

  function assertPresetStateMatchesCurrentProvider(
    projectId: string,
    state: FilterPreset['state']
  ): void {
    const provider = legacyProjectConfig(projectId).source;
    if (state.provider !== provider) {
      throw new Error(
        `Preset provider must match this project's ${sourceName(provider)} provider`
      );
    }
  }

  function assertPresetWriteMatchesCurrentProvider(
    projectId: string,
    id: string | undefined,
    state: FilterPreset['state']
  ): void {
    if (id) {
      const existing = store
        .listFilterPresets(projectId)
        .find(preset => preset.id === id);
      if (!existing) throw new Error(`Unknown filter preset: ${id}`);
      if (JSON.stringify(existing.state) !== JSON.stringify(state)) {
        throw new Error('Renaming a filter preset cannot change its state');
      }
      return;
    }
    assertPresetStateMatchesCurrentProvider(projectId, state);
  }

  function saveFilterPresetLinearized(input: {
    projectId: string;
    id?: string;
    name: string;
    state: FilterPreset['state'];
  }): Promise<{ preset: FilterPreset; presets: FilterPreset[] }> {
    return enqueueMutation(input.projectId, SOURCES, async () => {
      assertPresetWriteMatchesCurrentProvider(
        input.projectId,
        input.id,
        input.state
      );
      const preset = store.saveFilterPreset(input);
      const presets = store.listFilterPresets(input.projectId);
      publishFilterPresetsChanged(input.projectId);
      return { preset, presets };
    });
  }

  async function fallbackGithubRepos(projectId: string): Promise<string[]> {
    const project = (await liveProjects()).find(
      entry => entry.id === projectId
    );
    const repo = parseGithubRepoFromRemote(
      typeof project === 'object' &&
        project !== null &&
        'gitRemoteUrl' in project &&
        typeof project.gitRemoteUrl === 'string'
        ? project.gitRemoteUrl
        : null
    );
    return repo ? [repo] : [];
  }

  function legacyProjectConfig(projectId: string): ProjectSourceConfig {
    const connected = store.projectSources(projectId);
    const linear = connected.find(entry => entry.source === 'linear');
    const jira = connected.find(entry => entry.source === 'jira');
    return projectSourceConfigSchema.parse({
      projectId,
      source: connected[0]?.source ?? 'github',
      linearTeamKey: linear?.source === 'linear' ? linear.teamKey : '',
      jiraBaseUrl: jira?.source === 'jira' ? jira.baseUrl : '',
      jiraEmail: jira?.source === 'jira' ? jira.email : '',
      jiraJql: jira?.source === 'jira' ? jira.jql : DEFAULT_JIRA_JQL
    });
  }

  function syncKey(projectId: string, source: WorkSource): string {
    return `${projectId}:${source}`;
  }

  const sourceRevisions = new Map<string, number>();
  const connectorRevisions = new Map<string, number>();
  type SourceRevisionSnapshot = Record<WorkSource, number>;
  interface ExpectedProjectMutationState {
    config: ProjectSourceConfig;
    revisions: SourceRevisionSnapshot;
  }

  function currentRevision(projectId: string, source: WorkSource): number {
    return sourceRevisions.get(syncKey(projectId, source)) ?? 0;
  }

  function currentConnectorRevision(
    projectId: string,
    source: WorkSource
  ): number {
    return connectorRevisions.get(syncKey(projectId, source)) ?? 0;
  }

  function revisionSnapshot(projectId: string): SourceRevisionSnapshot {
    return {
      linear: currentRevision(projectId, 'linear'),
      github: currentRevision(projectId, 'github'),
      jira: currentRevision(projectId, 'jira')
    };
  }

  function sameRevisions(
    projectId: string,
    expected: SourceRevisionSnapshot
  ): boolean {
    return SOURCES.every(
      source => currentRevision(projectId, source) === expected[source]
    );
  }

  function advanceSourceRevision(
    projectId: string,
    source: WorkSource
  ): number {
    const next = currentRevision(projectId, source) + 1;
    sourceRevisions.set(syncKey(projectId, source), next);
    return next;
  }

  function invalidateSource(projectId: string, source: WorkSource): void {
    advanceSourceRevision(projectId, source);
    connectorRevisions.set(
      syncKey(projectId, source),
      currentConnectorRevision(projectId, source) + 1
    );
    store.clearSource(projectId, source);
  }

  workspace.onCatalogChange(ids=>{for(const id of ids){invalidateSource(id,'github');bb.realtime.publish('taskboard:changed',{projectId:id,source:'github'});}});
  const mutationTails = new Map<string, Promise<void>>();
  let activeConfigMutations = 0;
  let migrationBarrier: Promise<void> | null = null;
  let releaseMigrationBarrier: (() => void) | null = null;
  const configIdleWaiters = new Set<() => void>();

  async function withConfigMutation<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    for (;;) {
      const barrier = migrationBarrier;
      if (!barrier) {
        activeConfigMutations += 1;
        break;
      }
      await barrier;
    }
    try {
      return await operation();
    } finally {
      activeConfigMutations -= 1;
      if (activeConfigMutations === 0) {
        for (const resolve of configIdleWaiters) resolve();
        configIdleWaiters.clear();
      }
    }
  }

  async function withExclusiveMigration<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    while (migrationBarrier) await migrationBarrier;
    migrationBarrier = new Promise<void>(resolve => {
      releaseMigrationBarrier = resolve;
    });
    if (activeConfigMutations > 0) {
      await new Promise<void>(resolve => configIdleWaiters.add(resolve));
    }
    try {
      return await operation();
    } finally {
      const release = releaseMigrationBarrier;
      releaseMigrationBarrier = null;
      migrationBarrier = null;
      release?.();
    }
  }

  function enqueueMutation<T>(
    projectId: string,
    sources: readonly WorkSource[],
    operation: () => Promise<T>
  ): Promise<T> {
    const keys = [
      ...new Set(sources.map(source => syncKey(projectId, source)))
    ].sort();
    const previous = Promise.all(
      keys.map(key => mutationTails.get(key) ?? Promise.resolve())
    );
    const result = previous.then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    for (const key of keys) mutationTails.set(key, tail);
    void tail.finally(() => {
      for (const key of keys) {
        if (mutationTails.get(key) === tail) mutationTails.delete(key);
      }
    });
    return result;
  }

  async function waitForMutations(
    projectId: string,
    sources: readonly WorkSource[]
  ): Promise<void> {
    await Promise.all(
      sources.map(
        source =>
          mutationTails.get(syncKey(projectId, source)) ?? Promise.resolve()
      )
    );
  }

  async function buildProjectConfigView(
    config: ProjectSourceConfig
  ): Promise<ProjectConfigView> {
    const [
      linearCredentialConfigured,
      jiraCredentialConfigured,
      githubRepos,
      sources
    ] = await Promise.all([
      credentials.configured(config.projectId, 'linear'),
      credentials.configured(config.projectId, 'jira'),
      workspace
        .githubStatus()
        .then(status => githubReposForProject(status, config.projectId))
        .catch(() => fallbackGithubRepos(config.projectId)),
      sourceViews(config.projectId)
    ]);
    return {
      ...config,
      githubRepos,
      linearCredentialConfigured,
      jiraCredentialConfigured,
      sources
    };
  }

  async function readConsistentProjectConfigView(
    projectId: string
  ): Promise<{
    config: ProjectConfigView;
    revisions: SourceRevisionSnapshot;
  }> {
    for (;;) {
      await waitForMutations(projectId, SOURCES);
      const before = revisionSnapshot(projectId);
      const config = await buildProjectConfigView(
        legacyProjectConfig(projectId)
      );
      const after = revisionSnapshot(projectId);
      if (SOURCES.every(source => before[source] === after[source])) {
        return { config, revisions: after };
      }
    }
  }

  async function readProjectConfigView(
    projectId: string
  ): Promise<ProjectConfigView> {
    return (await readConsistentProjectConfigView(projectId)).config;
  }

  async function getCreateIssueContext(
    projectId: string,
    requested?: WorkSource
  ): Promise<CreateIssueContext> {
    const [project, config, currentAdapters] = await Promise.all([
      projectById(projectId),
      readProjectConfigView(projectId),
      adapters(projectId)
    ]);
    const connected = store.projectSources(projectId);
    const entry = requested
      ? connected.find(candidate => candidate.source === requested)
      : connected[0];
    const source = entry?.source ?? requested ?? 'github';
    const destinationLabel =
      source === 'github'
        ? 'Repository'
        : source === 'linear'
          ? 'Team'
          : 'Project key';
    if (!entry) {
      return {
        projectId,
        projectName: project.name,
        source,
        available: false,
        message: 'Нет подключённых источников задач',
        destinationLabel,
        destinations: [],
        defaultDestinationId: null,
        allowsCustomDestination: source === 'jira',
        defaultIssueType: source === 'jira' ? 'Task' : null
      };
    }
    const adapter = currentAdapters.get(entry.source);
    if (!adapter) throw new Error(`Missing ${entry.source} adapter`);

    let githubMessage: string | null = null;
    let githubRepos = config.githubRepos;
    if (entry.source === 'github') {
      try {
        const status = await workspace.githubStatus();
        githubRepos = githubReposForProject(status, projectId);
        if (!status.ghOk) {
          githubMessage = status.ghError ?? 'GitHub is not authenticated.';
        }
      } catch {
        githubRepos = [];
        githubMessage =
          'Install and enable BB’s official GitHub plugin before creating GitHub issues.';
      }
    }
    const destinationIds =
      entry.source === 'github'
        ? githubRepos
        : entry.source === 'linear'
          ? [entry.teamKey]
          : jiraProjectKeysFromJql(entry.jql);
    const destinations = destinationIds.map(id => ({ id, label: id }));
    const missingDestinationMessage =
      entry.source === 'github' && destinations.length === 0
        ? 'Map at least one GitHub repository to this BB project.'
        : null;
    const configurationMessage =
      githubMessage ??
      (adapter.configured() ? null : adapter.configurationMessage());

    return {
      projectId,
      projectName: project.name,
      source: entry.source,
      available:
        configurationMessage === null && missingDestinationMessage === null,
      message: configurationMessage ?? missingDestinationMessage,
      destinationLabel,
      destinations,
      defaultDestinationId: destinations[0]?.id ?? null,
      allowsCustomDestination: entry.source === 'jira',
      defaultIssueType: entry.source === 'jira' ? 'Task' : null
    };
  }

  async function getCreateIssueMetadata(input: {
    projectId: string;
    expectedSource: WorkSource;
    destinationId: string;
    issueType: string | null;
  }) {
    await waitForMutations(input.projectId, SOURCES);
    assertConnectedSource(input.projectId, input.expectedSource);
    const source = input.expectedSource;
    const connectorRevision = currentConnectorRevision(input.projectId, source);
    const adapter = (await adapters(input.projectId)).get(source);
    if (!adapter) throw new Error(`Missing ${source} adapter`);
    assertExpectedConnectorRevision(
      connectorRevision,
      currentConnectorRevision(input.projectId, source),
      source
    );
    if (!adapter.configured()) {
      throw new Error(
        adapter.configurationMessage() ??
          `${sourceName(source)} is not configured`
      );
    }
    let metadata: CreateIssueMetadata;
    try {
      metadata = createIssueMetadataSchema.parse(
        await adapter.createMetadata({
          destinationId: input.destinationId,
          issueType: input.issueType
        })
      );
    } catch (error) {
      return createSafeIssueMetadataFailure(source, error);
    }
    assertExpectedConnectorRevision(
      connectorRevision,
      currentConnectorRevision(input.projectId, source),
      source
    );
    return { ok: true as const, metadata, connectorRevision };
  }

  function readCredentialFormSnapshot(projectId: string) {
    return readConsistentProjectConfigView(projectId);
  }

  function adapterFor(
    projectId: string,
    entry: ProjectSource,
    secret: string | undefined
  ): WorkSourceAdapter {
    if (entry.source === 'linear') {
      return createLinearAdapter({
        enabled: true,
        apiKey: secret,
        teamKey: entry.teamKey
      });
    }
    if (entry.source === 'jira') {
      return createJiraAdapter({
        enabled: true,
        baseUrl: entry.baseUrl,
        cloudId: entry.cloudId,
        email: entry.email,
        apiToken: secret,
        jql: entry.jql
      });
    }
    return createGithubAdapter(
      workspace.scopedGithub(projectId),
      true,
      projectId,
      workspace.cli(projectId)
    );
  }

  async function adapters(
    projectId: string
  ): Promise<Map<WorkSource, WorkSourceAdapter>> {
    for (;;) {
      await waitForMutations(projectId, SOURCES);
      const before = revisionSnapshot(projectId);
      const connected = store.projectSources(projectId);
      const secrets = new Map<WorkSource, string | undefined>();
      for (const entry of connected) {
        if (entry.source !== 'github') {
          secrets.set(
            entry.source,
            await credentials.read(projectId, entry.source)
          );
        }
      }
      const after = revisionSnapshot(projectId);
      if (!SOURCES.every(source => before[source] === after[source])) continue;
      return new Map(
        connected.map(entry => [
          entry.source,
          adapterFor(projectId, entry, secrets.get(entry.source))
        ])
      );
    }
  }

  async function statuses(
    projectId: string,
    currentAdapters?: Map<WorkSource, WorkSourceAdapter>
  ): Promise<WorkSourceStatus[]> {
    const availableAdapters = currentAdapters ?? (await adapters(projectId));
    return [...availableAdapters.entries()].map(([source, adapter]) => {
      const sync = store.syncState(projectId, source);
      const configured = adapter.configured();
      return {
        source,
        configured,
        available:
          configured && sync.error === null && sync.lastSyncedAt !== null,
        message: configured ? sync.error : adapter.configurationMessage(),
        lastSyncedAt: sync.lastSyncedAt,
        itemCount: sync.itemCount
      };
    });
  }

  function assertConnectedSource(
    projectId: string,
    source: WorkSource
  ): void {
    if (!store.projectSource(projectId, source)) {
      throw new Error(
        `${SOURCE_TITLE[source]} не подключен${source === 'jira' ? 'а' : ''} к проекту`
      );
    }
  }

  async function syncOne(
    projectId: string,
    source: WorkSource,
    currentAdapters: Map<WorkSource, WorkSourceAdapter>,
    revision: number,
    forceRefresh: boolean
  ): Promise<void> {
    const adapter = currentAdapters.get(source);
    if (!adapter) throw new Error(`Missing ${source} adapter`);
    if (!adapter.configured()) {
      if (currentRevision(projectId, source) === revision) {
        store.setSourceError(
          projectId,
          source,
          adapter.configurationMessage() ??
            `${sourceName(source)} is not configured`
        );
      }
      return;
    }
    try {
      const items = (await adapter.list({ refresh: forceRefresh })).map(item =>
        scopedItem(projectId, item)
      );
      if (currentRevision(projectId, source) !== revision) return;
      store.replaceSource(projectId, source, items, new Date().toISOString());
    } catch (error) {
      const message = errorMessage(error);
      if (currentRevision(projectId, source) !== revision) return;
      store.setSourceError(projectId, source, message);
      bb.log.warn(
        `${sourceName(source)} sync failed for ${projectId}: ${message}`
      );
    }
  }

  const activeSyncs = new Map<
    string,
    { revision: number; forceRefresh: boolean; promise: Promise<void> }
  >();
  function syncSource(
    projectId: string,
    source: WorkSource,
    currentAdapters: Map<WorkSource, WorkSourceAdapter>,
    revision: number,
    forceRefresh: boolean
  ): Promise<void> {
    const key = syncKey(projectId, source);
    if (currentRevision(projectId, source) !== revision) {
      return Promise.resolve();
    }
    const active = activeSyncs.get(key);
    if (
      active?.revision === revision &&
      (active.forceRefresh || !forceRefresh)
    ) {
      return active.promise;
    }
    const run = () =>
      syncOne(projectId, source, currentAdapters, revision, forceRefresh);
    const pending =
      active?.revision === revision
        ? active.promise.then(() => {
            if (currentRevision(projectId, source) !== revision) return;
            return run();
          })
        : run();
    const promise = pending.finally(() => {
      if (activeSyncs.get(key)?.promise === promise) activeSyncs.delete(key);
    });
    activeSyncs.set(key, { revision, forceRefresh, promise });
    return promise;
  }

  async function syncAll(
    projectId: string,
    source: WorkSource | undefined,
    forceRefresh: boolean
  ): Promise<WorkSourceStatus[]> {
    await waitForMutations(projectId, SOURCES);
    if (source) assertConnectedSource(projectId, source);
    const targets = source
      ? [source]
      : store.projectSources(projectId).map(entry => entry.source);
    const revisions = new Map(
      targets.map(target => [target, currentRevision(projectId, target)])
    );
    const currentAdapters = await adapters(projectId);
    await Promise.all(
      targets
        .filter(target => currentAdapters.has(target))
        .map(target =>
          syncSource(
            projectId,
            target,
            currentAdapters,
            revisions.get(target)!,
            forceRefresh
          )
        )
    );
    const nextStatuses = await statuses(projectId, currentAdapters);
    bb.realtime.publish('taskboard:changed', {
      projectId,
      source: source ?? null
    });
    return nextStatuses;
  }

  function scheduleSources(
    projectId: string,
    sources: readonly WorkSource[]
  ): void {
    void Promise.all(
      sources.map(source => syncAll(projectId, source, false))
    ).catch((error: unknown) => {
      bb.log.warn(
        `Taskboard sync failed for ${projectId}: ${errorMessage(error)}`
      );
    });
  }

  async function restoreCredential(
    projectId: string,
    source: CredentialSource,
    previous: string | undefined
  ): Promise<void> {
    const mutation: SecretMutation = previous
      ? { operation: 'set', value: previous }
      : { operation: 'clear' };
    await credentials.mutate(projectId, source, mutation);
  }

  function sameProjectConfig(
    left: ProjectSourceConfig,
    right: ProjectSourceConfig
  ): boolean {
    return (
      left.projectId === right.projectId &&
      left.source === right.source &&
      left.linearTeamKey === right.linearTeamKey &&
      left.jiraBaseUrl === right.jiraBaseUrl &&
      left.jiraEmail === right.jiraEmail &&
      left.jiraJql === right.jiraJql
    );
  }

  async function sourceViews(
    projectId: string
  ): Promise<ProjectSourceView[]> {
    return Promise.all(
      store.projectSources(projectId).map(async entry => ({
        ...entry,
        credentialConfigured:
          entry.source === 'github'
            ? true
            : await credentials.configured(projectId, entry.source)
      }))
    );
  }

  function sourceMutationFor(
    input: ProjectConfigMutation
  ): ProjectSourceMutation {
    if (input.source === 'linear') {
      return {
        projectId: input.projectId,
        source: 'linear',
        teamKey: input.linearTeamKey,
        credential: input.linearCredential
      };
    }
    if (input.source === 'jira') {
      const current = store.projectSource(input.projectId, 'jira');
      return {
        projectId: input.projectId,
        source: 'jira',
        baseUrl: input.jiraBaseUrl,
        cloudId: current?.source === 'jira' ? current.cloudId : '',
        email: input.jiraEmail,
        jql: input.jiraJql,
        credential: input.jiraCredential
      };
    }
    return { projectId: input.projectId, source: 'github' };
  }

  async function saveSourceInner(
    input: ProjectSourceMutation
  ): Promise<ProjectSourceView> {
    await assertProjectExists(input.projectId);
    const { credential: _ignored, ...plain } = input as
      ProjectSourceMutation & { credential?: unknown };
    const value = projectSourceSchema.parse(plain);
    const existing = store.projectSource(input.projectId, input.source);
    if (
      value.source === 'jira' &&
      input.source === 'jira' &&
      input.credential.operation === 'keep' &&
      existing?.source === 'jira' &&
      (existing.baseUrl !== value.baseUrl ||
        existing.email !== value.email ||
        existing.cloudId !== value.cloudId)
    ) {
      throw new Error(
        'Смена адреса, email или cloudId Jira требует нового токена'
      );
    }
    const credentialKept =
      input.source === 'github' || input.credential.operation === 'keep';
    const unchanged =
      existing !== undefined &&
      JSON.stringify(existing) === JSON.stringify(value);
    if (unchanged && credentialKept) {
      return (await sourceViews(input.projectId)).find(
        view => view.source === input.source
      )!;
    }
    const previousSecret =
      input.source === 'github'
        ? undefined
        : await credentials.read(input.projectId, input.source);
    const retargetsJira =
      value.source === 'jira' &&
      input.source === 'jira' &&
      input.credential.operation === 'set' &&
      existing?.source === 'jira' &&
      (existing.baseUrl !== value.baseUrl ||
        existing.email !== value.email ||
        existing.cloudId !== value.cloudId);
    if (retargetsJira) {
      // Новый адрес сначала живёт без токена: если процесс умрёт между
      // записями, старый сайт не получит чужой токен.
      await credentials.mutate(input.projectId, 'jira', {
        operation: 'clear'
      });
      try {
        store.saveProjectSource(value);
      } catch (error) {
        await restoreCredential(input.projectId, 'jira', previousSecret);
        throw error;
      }
      await credentials.mutate(input.projectId, 'jira', input.credential);
    } else {
      if (input.source !== 'github' && input.credential.operation !== 'keep') {
        await credentials.mutate(
          input.projectId,
          input.source,
          input.credential
        );
      }
      try {
        store.saveProjectSource(value);
      } catch (error) {
        if (input.source !== 'github') {
          await restoreCredential(
            input.projectId,
            input.source,
            previousSecret
          );
        }
        throw error;
      }
    }
    invalidateSource(input.projectId, input.source);
    scheduleSources(input.projectId, [input.source]);
    return (await sourceViews(input.projectId)).find(
      view => view.source === input.source
    )!;
  }

  async function saveSource(
    input: ProjectSourceMutation
  ): Promise<ProjectSourceView> {
    const parsed = projectSourceMutationSchema.parse(input);
    await assertProjectExists(parsed.projectId);
    return withConfigMutation(() =>
      enqueueMutation(parsed.projectId, [parsed.source], () =>
        saveSourceInner(parsed)
      )
    );
  }

  async function disconnectSource(
    projectId: string,
    source: WorkSource
  ): Promise<ProjectSourceView[]> {
    await assertProjectExists(projectId);
    return withConfigMutation(() =>
      enqueueMutation(projectId, [source], async () => {
        invalidateSource(projectId, source);
        store.deleteProjectSource(projectId, source);
        if (source !== 'github') {
          await credentials.mutate(projectId, source, { operation: 'clear' });
        }
        bb.realtime.publish('taskboard:changed', { projectId, source });
        return sourceViews(projectId);
      })
    );
  }

  async function testSource(projectId: string, source: WorkSource) {
    await assertProjectExists(projectId);
    assertConnectedSource(projectId, source);
    const adapter = (await adapters(projectId)).get(source);
    if (!adapter?.configured()) {
      return {
        ok: false,
        message: adapter?.configurationMessage() ?? 'Не настроено',
        itemCount: null
      };
    }
    try {
      const items = await adapter.list({ refresh: true });
      return { ok: true, message: null, itemCount: items.length };
    } catch (error) {
      return { ok: false, message: errorMessage(error), itemCount: null };
    }
  }

  async function persistProjectConfig(
    rawInput: ProjectConfigMutation,
    expectedState?: ExpectedProjectMutationState
  ): Promise<ProjectConfigView> {
    const input = projectConfigMutationSchema.parse(rawInput);
    const config = await withConfigMutation(() =>
      enqueueMutation(input.projectId, SOURCES, async () => {
        if (expectedState) {
          const previous = legacyProjectConfig(input.projectId);
          if (
            !sameProjectConfig(previous, expectedState.config) ||
            !sameRevisions(input.projectId, expectedState.revisions)
          ) {
            throw new Error(
              'Project connector state changed while the credential form was open; reopen it and confirm the current settings'
            );
          }
        }
        const mutations: ProjectSourceMutation[] = [
          sourceMutationFor(input)
        ];
        const otherSource =
          input.source === 'linear'
            ? 'jira'
            : input.source === 'jira'
              ? 'linear'
              : null;
        const otherCredential =
          otherSource === 'jira'
            ? input.jiraCredential
            : otherSource === 'linear'
              ? input.linearCredential
              : null;
        if (
          otherSource &&
          otherCredential !== null &&
          otherCredential.operation !== 'keep'
        ) {
          const row = store.projectSource(input.projectId, otherSource);
          if (row?.source === 'linear') {
            mutations.push({
              projectId: input.projectId,
              source: 'linear',
              teamKey: row.teamKey,
              credential: otherCredential
            });
          } else if (row?.source === 'jira') {
            mutations.push({
              projectId: input.projectId,
              source: 'jira',
              baseUrl: row.baseUrl,
              cloudId: row.cloudId,
              email: row.email,
              jql: row.jql,
              credential: otherCredential
            });
          }
        }
        for (const mutation of mutations) {
          await saveSourceInner(mutation);
        }
        return legacyProjectConfig(input.projectId);
      })
    );

    bb.realtime.publish('taskboard:changed', {
      projectId: input.projectId,
      source: null
    });
    return buildProjectConfigView(config);
  }

  async function getLiveItem(
    projectId: string,
    source: WorkSource,
    locator: string
  ): Promise<WorkItemDetail> {
    assertConnectedSource(projectId, source);
    await waitForMutations(projectId, [source]);
    assertConnectedSource(projectId, source);
    if (!store.get(projectId, source, locator)) {
      throw new Error(
        `${sourceName(source)} item is not cached for this BB project; refresh the project tracker first`
      );
    }
    const revision = currentRevision(projectId, source);
    const adapter = (await adapters(projectId)).get(source);
    if (!adapter) {
      assertConnectedSource(projectId, source);
      throw new Error(`Missing ${source} adapter`);
    }
    if (currentRevision(projectId, source) !== revision) {
      throw new Error(
        `${sourceName(source)} settings changed while loading the item; reopen it`
      );
    }
    if (!adapter.configured()) {
      throw new Error(
        adapter.configurationMessage() ??
          `${sourceName(source)} is not configured`
      );
    }
    let externalItem: ExternalWorkItemDetail;
    try {
      externalItem = await adapter.get(locator);
    } catch {
      throw new Error(
        `${sourceName(source)} could not load the requested item`
      );
    }
    if (currentRevision(projectId, source) !== revision) {
      throw new Error(
        `${sourceName(source)} settings changed while loading the item; reopen it`
      );
    }
    return scopedItemDetail(projectId, externalItem);
  }

  async function liveStatusOptions(
    projectId: string,
    source: WorkSource,
    locator: string
  ): Promise<WorkStatusOption[]> {
    assertConnectedSource(projectId, source);
    await waitForMutations(projectId, [source]);
    assertConnectedSource(projectId, source);
    if (!store.get(projectId, source, locator)) {
      throw new Error(
        `${sourceName(source)} item is not cached for this BB project; refresh the project tracker first`
      );
    }
    const revision = currentRevision(projectId, source);
    const adapter = (await adapters(projectId)).get(source);
    if (!adapter) {
      assertConnectedSource(projectId, source);
      throw new Error(`Missing ${source} adapter`);
    }
    if (currentRevision(projectId, source) !== revision) {
      throw new Error(
        `${sourceName(source)} settings changed while loading statuses; try again`
      );
    }
    if (!adapter.configured()) {
      throw new Error(
        adapter.configurationMessage() ??
          `${sourceName(source)} is not configured`
      );
    }
    let options: WorkStatusOption[];
    try {
      options = workStatusOptionSchema
        .array()
        .parse(await adapter.statusOptions(locator));
    } catch (error) {
      const message = errorMessage(error);
      throw new Error(
        message.includes('outside the configured scope')
          ? message
          : `${sourceName(source)} could not load valid statuses for this item`
      );
    }
    if (currentRevision(projectId, source) !== revision) {
      throw new Error(
        `${sourceName(source)} settings changed while loading statuses; try again`
      );
    }
    if (new Set(options.map(option => option.id)).size !== options.length) {
      throw new Error(`${sourceName(source)} returned duplicate status ids`);
    }
    if (!options.some(option => option.current)) {
      throw new Error(
        `${sourceName(source)} did not return the current status`
      );
    }
    return options;
  }

  async function updateItemStatus(
    projectId: string,
    source: WorkSource,
    locator: string,
    statusId: string
  ): Promise<WorkItem> {
    assertConnectedSource(projectId, source);
    await waitForMutations(projectId, [source]);
    assertConnectedSource(projectId, source);
    const cached = store.get(projectId, source, locator);
    if (!cached) {
      throw new Error(
        `${sourceName(source)} item is not cached for this BB project; refresh the project tracker first`
      );
    }
    const revision = currentRevision(projectId, source);
    const adapter = (await adapters(projectId)).get(source);
    if (!adapter) {
      assertConnectedSource(projectId, source);
      throw new Error(`Missing ${source} adapter`);
    }
    if (!adapter.configured()) {
      throw new Error(
        adapter.configurationMessage() ??
          `${sourceName(source)} is not configured`
      );
    }
    const mutation = enqueueMutation(projectId, [source], async () => {
      if (currentRevision(projectId, source) !== revision) {
        throw new Error(
          `${sourceName(source)} settings changed before the status update; try again`
        );
      }
      if (!store.get(projectId, source, locator)) {
        throw new Error(
          `${sourceName(source)} item is no longer cached for this BB project`
        );
      }
      advanceSourceRevision(projectId, source);
      let externalItem: ExternalWorkItemDetail;
      try {
        externalItem = await adapter.updateStatus(locator, statusId);
      } catch (error) {
        const message = errorMessage(error);
        throw new Error(
          message.includes('not available') ||
            message.includes('outside the configured scope')
            ? message
            : `${sourceName(source)} could not update this item status`
        );
      }
      if (externalItem.source !== source || externalItem.locator !== locator) {
        throw new Error(
          `${sourceName(source)} returned an invalid status update result`
        );
      }
      const item = scopedItem(projectId, withoutComments(externalItem));
      store.upsert(item);
      bb.realtime.publish('taskboard:changed', { projectId, source });
      return item;
    });
    void mutation
      .then(
        () => syncAll(projectId, source, false),
        () => syncAll(projectId, source, false)
      )
      .catch((error: unknown) => {
        bb.log.warn(
          `${sourceName(source)} reconciliation failed for ${projectId}: ${errorMessage(error)}`
        );
      });
    return mutation;
  }

  async function createWorkItem(
    input: CreateIssueInput
  ): Promise<{
    item: WorkItem;
    warnings: string[];
    assigneeConfirmation: ExternalWorkItemCreateResult['assigneeConfirmation'];
  }> {
    await waitForMutations(input.projectId, SOURCES);
    assertConnectedSource(input.projectId, input.expectedSource);
    const source = input.expectedSource;
    const connectorRevision = currentConnectorRevision(input.projectId, source);
    assertExpectedConnectorRevision(
      input.connectorRevision,
      connectorRevision,
      source
    );
    const revision = currentRevision(input.projectId, source);
    const adapter = (await adapters(input.projectId)).get(source);
    if (!adapter) throw new Error(`Missing ${source} adapter`);
    if (!adapter.configured()) {
      throw new Error(
        adapter.configurationMessage() ?? `${sourceName(source)} is not configured`
      );
    }

    const mutation = enqueueMutation(input.projectId, [source], async () => {
      if (currentRevision(input.projectId, source) !== revision) {
        throw new Error(
          `${sourceName(source)} settings changed before the issue was created; try again`
        );
      }
      assertExpectedConnectorRevision(
        input.connectorRevision,
        currentConnectorRevision(input.projectId, source),
        source
      );
      advanceSourceRevision(input.projectId, source);
      let externalItem: ExternalWorkItemDetail;
      let warnings: string[];
      // Preserve the provider-native confirmation separately from display text.
      let assigneeConfirmation: ExternalWorkItemCreateResult['assigneeConfirmation'];
      try {
        const result = await adapter.create({
          title: input.title,
          description: input.description,
          destinationId: input.destinationId,
          issueType: input.issueType,
          statusId: input.statusId,
          assigneeId: input.assigneeId,
          priorityId: input.priorityId,
          labelIds: input.labelIds,
          dueDate: input.dueDate,
          milestoneId: input.milestoneId
        });
        externalItem = result.item;
        warnings = result.warnings;
        assigneeConfirmation = result.assigneeConfirmation;
      } catch (error) {
        throw new Error(
          `${sourceName(source)} could not create the issue. ${errorMessage(error)}`
        );
      }
      if (externalItem.source !== source || !externalItem.locator) {
        throw new Error(
          `${sourceName(source)} returned an invalid new issue`
        );
      }
      const item = scopedItem(input.projectId, withoutComments(externalItem));
      store.upsert(item);
      bb.realtime.publish('taskboard:changed', {
        projectId: input.projectId,
        source
      });
      return { item, warnings, assigneeConfirmation };
    });
    void reconcileIssueCreation(mutation, forceRefresh =>
      syncAll(input.projectId, source, forceRefresh)
    )
      .catch((error: unknown) => {
        bb.log.warn(
          `${sourceName(source)} reconciliation failed for ${input.projectId}: ${errorMessage(error)}`
        );
      });
    return mutation;
  }

  const handlers: PluginRpcHandlers<typeof taskboardRpcContract> = {
    async listProjects() {
      return { projects: await listProjects() };
    },
    async threadProject(input) {
      const thread = await bb.sdk.threads.get({ threadId: input.threadId });
      await assertProjectExists(thread.projectId);
      return { projectId: thread.projectId };
    },
    async status(input) {
      await assertProjectExists(input.projectId);
      return { sources: await statuses(input.projectId) };
    },
    async listItems(input) {
      if (input.projectId) {
        await assertProjectExists(input.projectId);
        await waitForMutations(input.projectId, SOURCES);
        if (input.source) assertConnectedSource(input.projectId, input.source);
        return {
          items: store.list(input),
          providers: store
            .projectSources(input.projectId)
            .map(entry => entry.source)
        };
      }
      const projects = await listProjects();
      return {
        items: store.list({
          ...input,
          projectIds: projects.map(project => project.id)
        }),
        providers: []
      };
    },
    async refresh(input) {
      await assertProjectExists(input.projectId);
      const nextStatuses = await syncAll(input.projectId, input.source, true);
      return {
        sources: nextStatuses,
        itemCount: refreshedItemCount(nextStatuses, input.source)
      };
    },
    async getItem(input) {
      await assertProjectExists(input.projectId);
      return {
        item: await getLiveItem(input.projectId, input.source, input.locator)
      };
    },
    async statusOptions(input) {
      await assertProjectExists(input.projectId);
      return {
        options: await liveStatusOptions(
          input.projectId,
          input.source,
          input.locator
        )
      };
    },
    async updateItemStatus(input) {
      await assertProjectExists(input.projectId);
      return {
        item: await updateItemStatus(
          input.projectId,
          input.source,
          input.locator,
          input.statusId
        )
      };
    },
    async getCreateIssueContext(input) {
      await assertProjectExists(input.projectId);
      return {
        context: await getCreateIssueContext(input.projectId, input.source)
      };
    },
    async getCreateIssueMetadata(input) {
      await assertProjectExists(input.projectId);
      return getCreateIssueMetadata(input);
    },
    async createIssue(input) {
      await assertProjectExists(input.projectId);
      const { item, warnings, assigneeConfirmation } =
        await createWorkItem(input);
      return {
        item,
        warnings,
        assigneeConfirmation,
        mention: {
          provider: 'external-work-item',
          id: mentionId(item),
          label: item.key
        }
      };
    },
    async getProjectConfig(input) {
      await assertProjectExists(input.projectId);
      return { config: await readProjectConfigView(input.projectId) };
    },
    async saveProjectConfig(input) {
      return { config: await persistProjectConfig(input) };
    },
    async listProjectSources(input) {
      await assertProjectExists(input.projectId);
      const view = await readProjectConfigView(input.projectId);
      return {
        sources: await sourceViews(input.projectId),
        githubRepos: view.githubRepos
      };
    },
    async saveProjectSource(input) {
      return { source: await saveSource(input) };
    },
    async disconnectProjectSource(input) {
      return {
        sources: await disconnectSource(input.projectId, input.source)
      };
    },
    async testProjectSource(input) {
      return testSource(input.projectId, input.source);
    },
    async getProjectBoardSettings(input) {
      await assertProjectExists(input.projectId);
      return { settings: store.projectBoardSettings(input.projectId) };
    },
    async saveProjectBoardSettings(input) {
      await assertProjectExists(input.projectId);
      const settings = store.saveProjectBoardSettings(input);
      bb.realtime.publish('taskboard:changed', {
        projectId: settings.projectId,
        source: null
      });
      return { settings };
    },
    async listFilterPresets(input) {
      await assertProjectExists(input.projectId);
      return { presets: store.listFilterPresets(input.projectId) };
    },
    async saveFilterPreset(input) {
      await assertProjectExists(input.projectId);
      const result = await saveFilterPresetLinearized({
        projectId: input.projectId,
        ...(input.id ? { id: input.id } : {}),
        name: input.name,
        state: input.state
      });
      return {
        preset: filterPresetSummary(result.preset),
        presets: result.presets
      };
    },
    async deleteFilterPreset(input) {
      await assertProjectExists(input.projectId);
      const presets = store.deleteFilterPreset(input.projectId, input.id);
      publishFilterPresetsChanged(input.projectId);
      return { presets };
    },
    async reorderFilterPresets(input) {
      await assertProjectExists(input.projectId);
      const presets = store.reorderFilterPresets(input.projectId, input.ids);
      publishFilterPresetsChanged(input.projectId);
      return { presets };
    }
  };
  registerWorkBindings(bb,async ref=>{
    await assertProjectExists(ref.projectId);
    if(ref.source==='autopilot-overview'){
      await integrations.require('autopilot');
      const status=await bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method:'status',input:null,outputSchema:autopilotWorkContract.status.output});
      const {autopilotOverviewContext}=await import('./autopilot/overview-context.js');
      const locator=z.object({timeZone:z.string().max(100)}).parse(JSON.parse(ref.locator));
      return {title:'Разбор работы всего автопилота',context:autopilotOverviewContext(status,locator.timeZone)};
    }
    if(ref.source==='autopilot-project'){
      const [sourceId,project,timeZone]=z.tuple([z.string(),z.string(),z.string().max(100).optional()]).parse(JSON.parse(ref.locator));
      if(!(await workspace.read()).some(p=>p.bbProjectId===ref.projectId&&p.autopilotProject===project))throw Error('Автопилот не связан с выбранным проектом');
      await integrations.require('autopilot');
      const status=await bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method:'status',input:null,outputSchema:autopilotWorkContract.status.output});
      const detail=await bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method:'project',input:{sourceId,project},outputSchema:autopilotWorkContract.project.output});
      const {projectAnalysisContext}=await import('./autopilot/project-context.js');
      return {title:`Разбор проблем автопилота · ${project}`,context:projectAnalysisContext(status,sourceId,project,detail,timeZone)};
    }
    if(ref.source==='chat-watch')return chatWatch.describe(ref.projectId);
    if(ref.source==='autopilot-acceptance'){
      const [sourceId,project]=z.tuple([z.string(),z.string(),z.string().optional()]).parse(JSON.parse(ref.locator));
      if(!(await workspace.read()).some(p=>p.bbProjectId===ref.projectId&&p.autopilotProject===project))throw Error('Автопилот не связан с выбранным проектом');
      await integrations.require('autopilot');
      const status=await bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method:'status',input:null,outputSchema:autopilotWorkContract.status.output});
      const snapshot=status.snapshots.find(s=>s.source.id===sourceId);
      if(!snapshot?.data?.status.projects.some(p=>p.name===project))throw Error('Проект отсутствует в источнике');
      let detail=await bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method:'project',input:{sourceId,project,refresh:true},outputSchema:autopilotWorkContract.project.output});
      const deadline=Date.now()+105_000;
      while(detail.loading&&Date.now()<deadline){
        await new Promise(resolve=>setTimeout(resolve,500));
        detail=await bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method:'project',input:{sourceId,project},outputSchema:autopilotWorkContract.project.output});
      }
      if(detail.loading)throw Error('Проверка PR не завершилась вовремя. Повтори подготовку.');
      if(detail.error)throw Error(detail.error);
      if(!detail.data)throw Error('Источник не вернул список PR проекта.');
      if(detail.data.errors.length)throw Error(`Список PR неполный: ${detail.data.errors.join(' · ')}`);
      const prs=detail.data.prs.filter(pr=>pr.state.toUpperCase()==='OPEN');
      if(!prs.length)throw Error(`Открытых PR автопилота нет. Проверено ${detail.data.observedAt}.`);
      const rows=prs.map(pr=>`${pr.repo}#${pr.number??'?'} · ${pr.kind||'autopilot'} · ${pr.title||'Без названия'} · ${pr.url??'ссылка недоступна'} · обновлён ${pr.at||'неизвестно'}`);
      return {
        title:`Приёмка PR автопилота · ${project}`,
        fingerprint:JSON.stringify(prs.map(pr=>[pr.repo,pr.number,pr.state,pr.title,pr.at,pr.url]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))||Number(a[1])-Number(b[1]))),
        context:[
          `Проект автопилота: ${project}`,
          `Источник: ${snapshot.source.label} (${sourceId})`,
          `Проверено: ${detail.data.observedAt}`,
          '',
          `Открытые PR (${prs.length}):`,
          ...rows,
          '',
          'Проведи отдельную приёмку текущего HEAD каждого PR по правилам его репозитория. Проверь независимое AI-ревью и обязательные гейты, дождись post-review стадий пайплайна, затем смержи готовые PR или зафиксируй точную причину блокировки.',
        ].join('\n'),
      };
    }
    if(ref.source==='autopilot'){
      const [sourceId,project,problem]=z.tuple([z.string(),z.string(),z.string()]).parse(JSON.parse(ref.locator));
      if(!(await workspace.read()).some(p=>p.bbProjectId===ref.projectId&&p.autopilotProject===project))throw Error('Автопилот не связан с выбранным проектом');
      await integrations.require('autopilot');
      const status=await bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method:'status',input:null,outputSchema:autopilotWorkContract.status.output});
      const snapshot=status.snapshots.find(s=>s.source.id===sourceId);
      if(!snapshot?.data?.status.projects.some(p=>p.name===project))throw Error('Проект отсутствует в источнике');
      const detail=await bb.sdk.plugins.callRpc({pluginId:'oxi-autopilot',method:'project',input:{sourceId,project},outputSchema:autopilotWorkContract.project.output});
      const known=[...snapshot.data.status.alerts.filter(a=>a.startsWith(`${project}:`)),...(detail.data?.signals.flatMap(s=>s.rows)??[]),...(detail.data?.errors??[])];
      if(!known.includes(problem))throw Error('Наблюдение изменилось. Обнови проект.');
      return {title:`Автопилот · ${project}`,context:autopilotProblemContext(snapshot,project,problem,detail.data??null)};
    }
    if(ref.source==='tasknotes'){const [connectionId,path]=JSON.parse(ref.locator);if(typeof connectionId!=='string'||typeof path!=='string')throw Error('Некорректная ссылка TaskNotes');const note=await workspace.notesRead(ref.projectId,connectionId,path);return {title:note.title,context:readableWorkContext(note)};}
    if(ref.source==='github') {
      if(ref.kind==='epic')throw Error('Для GitHub epic укажи связанную issue');
      const match=ref.locator.match(/^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/);if(!match)throw Error('Некорректная ссылка PR');
      const item=await readItem(await workspace.forBb(ref.projectId),{repo:match[1],number:Number(match[2]),kind:ref.kind});
      return {title:`${ref.kind==='pr'?'PR':'Issue'} #${item.number}: ${item.title}`,context:readableWorkContext(item)};
    }
    const item=await getLiveItem(ref.projectId,ref.source,ref.locator);
    return {title:`${item.key}: ${item.title}`,context:formatWorkItemContext(item)};
  },async project=>[...new Map((await workspace.read()).filter(p=>p.autopilotProject===project&&p.bbProjectId).map(p=>[p.bbProjectId!,{id:p.bbProjectId!,name:p.name}])).values()],
    async()=>[...new Map((await workspace.read()).filter(p=>p.bbProjectId).map(p=>[p.bbProjectId!,{id:p.bbProjectId!,name:p.name}])).values()],
    async ref=>{if(ref.source==='tasknotes')await integrations.require('tasknotes');else if(ref.source.startsWith('autopilot')||ref.source==='chat-watch')await integrations.require('autopilot');});
  bb.rpc.register(linearMigrationContract,{importLinearConnection:async({projectId,teamKey,slot})=>{
    await assertProjectExists(projectId);
    if(await credentials.configured(projectId,'linear'))return {imported:false};
    await withLegacyLinearKey(bb,slot,async value=>{
      await createLinearAdapter({enabled:true,apiKey:value,teamKey}).list();
      await saveSource({projectId,source:'linear',teamKey,credential:{operation:'set',value}});
    });
    return {imported:true};
  }});
  bb.rpc.register(taskboardRpcContract, handlers);

  bb.ui.registerMentionProvider({
    id: 'external-work-item',
    label: 'Taskboard',
    triggers: ['@', '#'],
    async search({ query, projectId }) {
      const trimmed = query.trim();
      if (!projectId || trimmed.length < 2) return [];
      try {
        await assertProjectExists(projectId);
      } catch {
        return [];
      }
      return store.list({ projectId, query: trimmed, limit: 10 }).map(item => ({
        id: mentionId(item),
        title: `${item.key} ${item.title}`,
        subtitle: `${sourceName(item.source)} · ${item.status}${item.assignee ? ` · ${item.assignee}` : ''}`
      }));
    },
    async resolve(itemId) {
      const { projectId, source, locator } = parseMentionId(itemId);
      await assertProjectExists(projectId);
      assertConnectedSource(projectId, source);
      const item = store.get(projectId, source, locator);
      if (!item) throw new Error('Taskboard item is no longer available');
      return { context: formatWorkItemContext(item) };
    }
  });

  bb.cli.register({
    name: 'project-work',
    summary: 'Browse project-scoped Linear, GitHub, and Jira issues',
    commands: [
      {
        name: 'status',
        summary: 'Show connector status for a BB project',
        usage: 'bb project-work status [--project <proj_id>] [--json]'
      },
      {
        name: 'list',
        summary: 'List cached project work, refreshing first by default',
        usage:
          'bb project-work list [--project <proj_id>] ' +
          '[--source linear|github|jira] [--query <text>] ' +
          '[--preset <name>] [--cached] [--json]'
      },
      {
        name: 'show',
        summary: 'Fetch one external issue in a BB project',
        usage:
          'bb project-work show <linear|github|jira> <locator> [--project <proj_id>] [--json]'
      },
      {
        name: 'transitions',
        summary: 'List valid status targets for one external issue',
        usage:
          'bb project-work transitions <linear|github|jira> <locator> [--project <proj_id>] [--json]'
      },
      {
        name: 'move',
        summary: 'Move one external issue to an exact listed status id',
        usage:
          'bb project-work move <linear|github|jira> <locator> --status <id> [--project <proj_id>] [--json]'
      },
      {
        name: 'refresh',
        summary: "Refresh a BB project's external issue caches",
        usage:
          'bb project-work refresh [linear|github|jira] [--project <proj_id>] [--json]'
      },
      {
        name: 'config',
        summary: 'Show or update nonsecret project connector configuration',
        usage:
          'bb project-work config [--project <proj_id>] [--source linear|github|jira] [--linear-team <key>] [--jira-url <url>] [--jira-email <email>] [--jira-jql <text>] [--jira-cloud-id <id>] [--disconnect linear|github|jira] [--json]'
      },
      {
        name: 'jira',
        summary: 'Import a Jira connection from a project env file',
        usage:
          'bb project-work jira import --env <path> [--prefix <PREFIX>] ' +
          '--jql <text> [--project <proj_id>] [--json]'
      },
      {
        name: 'credentials',
        summary: 'Open a secure form for project connector credentials',
        usage: 'bb project-work credentials [--project <proj_id>] [--json]'
      },
      {
        name: 'presets',
        summary: 'List, save, rename, or delete project filter presets',
        usage:
          'bb project-work presets list [--project <proj_id>] [--json]\n' +
          'bb project-work presets save <name> --from-state <json> ' +
          '[--project <proj_id>] [--json]\n' +
          'bb project-work presets rename <name> <new-name> ' +
          '[--project <proj_id>] [--json]\n' +
          'bb project-work presets delete <name> ' +
          '[--project <proj_id>] [--json]'
      },
      {
        name: 'catalog',
        summary: 'Check autopilot, panel, and BB project lists for drift',
        usage: 'bb project-work catalog [--json]'
      }
    ],
    async run(argv, ctx) {
      try {
        const firstArgument = argv[0];
        const hasExplicitCommand = Boolean(
          firstArgument && !firstArgument.startsWith('--')
        );
        const command = hasExplicitCommand ? firstArgument! : 'status';
        if (command === 'catalog') {
          const rest = argv.slice(1);
          if (rest.some(arg => arg !== '--json')) {
            throw new Error('Usage: bb project-work catalog [--json]');
          }
          const report = await catalog.check();
          return {
            exitCode: report.findings.some(f => f.level === 'error') ? 1 : 0,
            stdout: rest.includes('--json')
              ? JSON.stringify(report, null, 2)
              : renderCatalog(report.findings)
          };
        }
        const args = parseTaskboardCliArguments(
          command,
          hasExplicitCommand ? argv.slice(1) : argv
        );
        const requireProject = async (): Promise<TrackerProject> => {
          const parsedProject = bbProjectIdSchema.safeParse(
            args.projectId ?? ctx.projectId
          );
          if (!parsedProject.success) {
            throw new Error(
              'Choose a BB project with --project <proj_id> or run this command from a project thread'
            );
          }
          return projectById(parsedProject.data);
        };

        if (command === 'status') {
          if (args.positionals.length > 0) {
            throw new Error(
              'Usage: bb project-work status [--project <proj_id>] [--json]'
            );
          }
          const project = await requireProject();
          const result = {
            projectId: project.id,
            sources: await statuses(project.id)
          };
          return {
            exitCode: 0,
            stdout: args.json
              ? JSON.stringify(result, null, 2)
              : result.sources
                  .map(
                    entry =>
                      `${sourceName(entry.source)}\t${entry.available ? 'ready' : entry.configured ? 'unavailable' : 'not configured'}\t${entry.message ?? ''}`
                  )
                  .join('\n')
          };
        }
        if (command === 'refresh') {
          if (args.positionals.length > 1) {
            throw new Error(
              'Usage: bb project-work refresh [linear|github|jira] [--project <proj_id>] [--json]'
            );
          }
          const project = await requireProject();
          const sourceValue = args.positionals[0];
          const parsedSource = sourceValue
            ? workSourceSchema.safeParse(sourceValue)
            : null;
          if (parsedSource && !parsedSource.success) {
            throw new Error('Source must be linear, github, or jira');
          }
          const source = parsedSource?.data;
          const sources = await syncAll(project.id, source, true);
          const result = {
            projectId: project.id,
            sources,
            itemCount: refreshedItemCount(sources, source)
          };
          const failures = source
            ? sources.filter(
                entry => entry.source === source && !entry.available
              )
            : sources.filter(entry => entry.configured && !entry.available);
          if (failures.length > 0) {
            return {
              exitCode: 1,
              stderr: `${failures
                .map(
                  entry =>
                    `${sourceName(entry.source)} refresh failed: ${entry.message ?? 'connector unavailable'}`
                )
                .join('\n')}\n`
            };
          }
          return {
            exitCode: 0,
            stdout: args.json
              ? JSON.stringify(result, null, 2)
              : `Refreshed ${result.itemCount} work items for ${project.id}.`
          };
        }
        if (command === 'list') {
          if (args.positionals.length > 0) {
            throw new Error(
              'Usage: bb project-work list [--project <proj_id>] ' +
                '[--source linear|github|jira] [--query <text>] ' +
                '[--preset <name>] [--cached] [--json]'
            );
          }
          const sourceValue = args.source;
          const parsedSource = sourceValue
            ? workSourceSchema.safeParse(sourceValue)
            : null;
          if (parsedSource && !parsedSource.success) {
            throw new Error('Source must be linear, github, or jira');
          }
          const project = await requireProject();
          // Explicit --source/--query flags beat a --preset's saved values;
          // a preset source of "all" means the preset applies no filter.
          const preset = args.preset
            ? resolvePresetByName(project.id, args.preset)
            : undefined;
          if (preset) {
            await assertPresetProviderIsCurrent(project.id, preset);
          }
          const selection = resolvePresetListSelection(
            preset,
            parsedSource?.data,
            args.query,
            store.projectBoardSettings(project.id).enabledFilters
          );
          const { source, query } = selection;
          if (source) {
            await waitForMutations(project.id, SOURCES);
            assertConnectedSource(project.id, source);
          }
          if (!args.cached) await syncAll(project.id, source, true);
          // Sync may wait behind a project reconfiguration. Recheck the
          // preset's provider at the read boundary so old-provider facets can
          // never filter a freshly switched provider's items.
          if (preset) {
            await assertPresetProviderIsCurrent(project.id, preset);
          }
          const items = store.list({
            projectId: project.id,
            ...(source ? { source } : {}),
            ...(query ? { query } : {}),
            ...(selection.stateCategories.length > 0
              ? { stateCategories: selection.stateCategories }
              : {}),
            limit: 500
          });
          const narrowedItems = (
            selection.attributeFilters
              ? filterWorkItemsByAttributes(
                  items,
                  selection.attributeFilters
                )
              : items
          ).slice(0, 200);
          return {
            exitCode: 0,
            stdout: args.json
              ? escapeExternalJsonOutput(
                  JSON.stringify({ items: narrowedItems }, null, 2)
                )
              : narrowedItems
                  .map(
                    item =>
                      `${escapeExternalInlineText(item.bbProjectId)}\t${sourceName(item.source)}\t${escapeExternalInlineText(item.key)}\t${escapeExternalInlineText(item.status)}\t${escapeExternalInlineText(item.assignee ?? '-')}\t${escapeExternalInlineText(item.title)}`
                  )
                  .join('\n')
          };
        }
        if (command === 'show') {
          if (args.positionals.length !== 2) {
            throw new Error(
              'Usage: bb project-work show <linear|github|jira> <locator> [--project <proj_id>] [--json]'
            );
          }
          const project = await requireProject();
          const parsedSource = workSourceSchema.safeParse(args.positionals[0]);
          const locator = args.positionals[1]!;
          if (!parsedSource.success) {
            throw new Error('Source must be linear, github, or jira');
          }
          const item = await getLiveItem(
            project.id,
            parsedSource.data,
            locator
          );
          return {
            exitCode: 0,
            stdout: args.json
              ? escapeExternalJsonOutput(JSON.stringify({ item, projectLink:taskLinkDirective(item) }, null, 2))
              : `${formatWorkItemContext(item)}\n\n${taskLinkDirective(item)}`
          };
        }
        if (command === 'transitions') {
          if (args.positionals.length !== 2) {
            throw new Error(
              'Usage: bb project-work transitions <linear|github|jira> <locator> [--project <proj_id>] [--json]'
            );
          }
          const project = await requireProject();
          const parsedSource = workSourceSchema.safeParse(args.positionals[0]);
          if (!parsedSource.success) {
            throw new Error('Source must be linear, github, or jira');
          }
          const locator = args.positionals[1]!;
          const options = await liveStatusOptions(
            project.id,
            parsedSource.data,
            locator
          );
          return {
            exitCode: 0,
            stdout: args.json
              ? escapeExternalJsonOutput(
                  JSON.stringify(
                    {
                      projectId: project.id,
                      source: parsedSource.data,
                      locator,
                      options
                    },
                    null,
                    2
                  )
                )
              : options
                  .map(
                    option =>
                      `${escapeExternalInlineText(option.id)}\t${escapeExternalInlineText(option.name)}\t${option.stateCategory}\t${option.current ? 'current' : 'available'}`
                  )
                  .join('\n')
          };
        }
        if (command === 'move') {
          if (args.positionals.length !== 2 || !args.statusId) {
            throw new Error(
              'Usage: bb project-work move <linear|github|jira> <locator> --status <id> [--project <proj_id>] [--json]'
            );
          }
          const project = await requireProject();
          const parsedSource = workSourceSchema.safeParse(args.positionals[0]);
          if (!parsedSource.success) {
            throw new Error('Source must be linear, github, or jira');
          }
          const item = await updateItemStatus(
            project.id,
            parsedSource.data,
            args.positionals[1]!,
            args.statusId
          );
          return {
            exitCode: 0,
            stdout: args.json
              ? escapeExternalJsonOutput(JSON.stringify({ item }, null, 2))
              : formatWorkItemContext(item)
          };
        }
        if (command === 'config') {
          if (args.positionals.length > 0) {
            throw new Error(
              'Usage: bb project-work config [--project <proj_id>] [--source linear|github|jira] [--linear-team <key>] [--jira-url <url>] [--jira-email <email>] [--jira-jql <text>] [--jira-cloud-id <id>] [--disconnect linear|github|jira] [--json]'
            );
          }
          const parsedSource = args.source
            ? workSourceSchema.safeParse(args.source)
            : null;
          if (parsedSource && !parsedSource.success) {
            throw new Error('--source must be linear, github, or jira');
          }
          const parsedDisconnect = args.disconnect
            ? workSourceSchema.safeParse(args.disconnect)
            : null;
          if (parsedDisconnect && !parsedDisconnect.success) {
            throw new Error('--disconnect must be linear, github, or jira');
          }
          if (args.jiraJql !== undefined && !args.jiraJql.trim()) {
            throw new Error('--jira-jql requires a non-empty value');
          }
          const project = await requireProject();
          const githubRepos = (await readProjectConfigView(project.id))
            .githubRepos;
          const printSources = (views: readonly ProjectSourceView[]) => ({
            exitCode: 0,
            stdout: args.json
              ? JSON.stringify({ sources: views, githubRepos }, null, 2)
              : formatProjectSources(views, githubRepos)
          });
          if (parsedDisconnect) {
            if (
              parsedSource !== null ||
              args.linearTeam !== undefined ||
              args.jiraUrl !== undefined ||
              args.jiraEmail !== undefined ||
              args.jiraJql !== undefined ||
              args.jiraCloudId !== undefined
            ) {
              throw new Error(
                '--disconnect cannot be combined with connector fields'
              );
            }
            return printSources(
              await disconnectSource(project.id, parsedDisconnect.data)
            );
          }
          const fieldsGiven =
            args.linearTeam !== undefined ||
            args.jiraUrl !== undefined ||
            args.jiraEmail !== undefined ||
            args.jiraJql !== undefined ||
            args.jiraCloudId !== undefined;
          if (fieldsGiven) {
            const source = parsedSource?.data;
            if (!source) {
              throw new Error(
                '--source is required when changing connector fields'
              );
            }
            const current = store.projectSource(project.id, source);
            let mutation: ProjectSourceMutation;
            if (source === 'linear') {
              if (
                args.jiraUrl !== undefined ||
                args.jiraEmail !== undefined ||
                args.jiraJql !== undefined ||
                args.jiraCloudId !== undefined
              ) {
                throw new Error('Jira flags require --source jira');
              }
              mutation = {
                projectId: project.id,
                source,
                teamKey:
                  args.linearTeam ??
                  (current?.source === 'linear' ? current.teamKey : ''),
                credential: KEEP_SECRET
              };
            } else if (source === 'jira') {
              if (args.linearTeam !== undefined) {
                throw new Error('--linear-team requires --source linear');
              }
              const jira = current?.source === 'jira' ? current : undefined;
              mutation = {
                projectId: project.id,
                source,
                baseUrl: args.jiraUrl ?? jira?.baseUrl ?? '',
                cloudId: args.jiraCloudId ?? jira?.cloudId ?? '',
                email: args.jiraEmail ?? jira?.email ?? '',
                jql: args.jiraJql ?? jira?.jql ?? '',
                credential: KEEP_SECRET
              };
            } else {
              throw new Error('GitHub Issues has no configurable fields');
            }
            await saveSource(mutation);
          } else if (parsedSource) {
            if (parsedSource.data === 'github') {
              await saveSource({ projectId: project.id, source: 'github' });
            } else {
              throw new Error(
                'Для подключения Linear/Jira укажи поля (--linear-team / --jira-url, --jira-email, --jira-jql)'
              );
            }
          }
          return printSources(await sourceViews(project.id));
        }
        if (command === 'jira') {
          if (args.positionals.length !== 1 || args.positionals[0] !== 'import') {
            throw new Error(
              'Usage: bb project-work jira import --env <path> [--prefix <PREFIX>] ' +
                '--jql <text> [--project <proj_id>] [--json]'
            );
          }
          if (!args.envPath) {
            throw new Error('Укажи --env <path> — путь к env-файлу');
          }
          if (!args.jql?.trim()) {
            throw new Error('Укажи --jql <text> — фильтр задач Jira');
          }
          const project = await requireProject();
          const env = await catalog.jiraEnv(args.envPath, args.envPrefix);
          await saveSource({
            projectId: project.id,
            source: 'jira',
            baseUrl: env.baseUrl,
            cloudId: env.cloudId,
            email: env.email,
            jql: args.jql,
            credential: { operation: 'set', value: env.token }
          });
          const check = await testSource(project.id, 'jira');
          const views = await sourceViews(project.id);
          const githubRepos = (await readProjectConfigView(project.id))
            .githubRepos;
          return {
            exitCode: check.ok ? 0 : 1,
            stdout: args.json
              ? JSON.stringify({ sources: views, check }, null, 2)
              : `${formatProjectSources(views, githubRepos)}\nПроверка: ${
                  check.ok
                    ? `ок · ${check.itemCount ?? 0} задач`
                    : `ошибка · ${check.message}`
                }`
          };
        }

        if (command === 'credentials') {
          if (args.positionals.length > 0) {
            throw new Error(
              'Usage: bb project-work credentials [--project <proj_id>] [--json]'
            );
          }
          if (!ctx.threadId) {
            throw new Error(
              'bb project-work credentials must run from an active BB thread'
            );
          }
          const project = await requireProject();
          const snapshot = await readCredentialFormSnapshot(project.id);
          const previous = snapshot.config;
          const result = await bb.ui.requestInput(
            {
              threadId: ctx.threadId,
              rendererId: 'taskboard-credentials',
              title: `Manage credentials for ${project.name}`,
              payload: {
                projectId: project.id,
                projectName: project.name,
                linearTeamKey: previous.linearTeamKey,
                jiraBaseUrl: previous.jiraBaseUrl,
                jiraEmail: previous.jiraEmail,
                linearCredentialConfigured: previous.linearCredentialConfigured,
                jiraCredentialConfigured: previous.jiraCredentialConfigured
              }
            },
            { signal: ctx.signal }
          );
          if (result.outcome === 'cancelled') {
            return {
              exitCode: 1,
              stderr: 'Credential update cancelled.\n'
            };
          }
          const parsedResponse =
            projectCredentialsInteractionResponseSchema.safeParse(result.value);
          if (!parsedResponse.success) {
            throw new Error('Credential form response was invalid');
          }
          const response = parsedResponse.data;
          const config = await persistProjectConfig(
            {
              projectId: previous.projectId,
              source: previous.source,
              linearTeamKey: previous.linearTeamKey,
              jiraBaseUrl: previous.jiraBaseUrl,
              jiraEmail: previous.jiraEmail,
              jiraJql: previous.jiraJql,
              linearCredential: response.linearCredential,
              jiraCredential: response.jiraCredential
            },
            { config: previous, revisions: snapshot.revisions }
          );
          return {
            exitCode: 0,
            stdout: args.json
              ? JSON.stringify(credentialStatus(config), null, 2)
              : formatCredentialStatus(config)
          };
        }
        if (command === 'presets') {
          const verb = args.positionals[0] ?? 'list';
          const rest = args.positionals.slice(1);
          if (!['list', 'save', 'rename', 'delete'].includes(verb)) {
            throw new Error(
              'Usage: bb project-work presets <list|save|rename|delete> ...'
            );
          }
          const project = await requireProject();

          if (verb === 'list') {
            if (rest.length > 0) {
              throw new Error(
                'Usage: bb project-work presets list ' +
                  '[--project <proj_id>] [--json]'
              );
            }
            const presets = store.listFilterPresets(project.id);
            return {
              exitCode: 0,
              stdout: args.json
                ? formatFilterPresetCliJson({ presets })
                : presets.length > 0
                  ? presets
                      .map(item => escapeExternalInlineText(item.name))
                      .join('\n')
                  : 'This project has no filter presets.'
            };
          }

          if (verb === 'save') {
            if (rest.length !== 1 || !args.fromState) {
              throw new Error(
                'Usage: bb project-work presets save <name> ' +
                  '--from-state <json> [--project <proj_id>] [--json]'
              );
            }
            let fromStateJson: unknown;
            try {
              fromStateJson = JSON.parse(args.fromState);
            } catch {
              throw new Error('--from-state must be valid JSON');
            }
            const parsedState =
              filterPresetStateSchema.safeParse(fromStateJson);
            if (!parsedState.success) {
              throw new Error(
                '--from-state is not a valid project browse preference state'
              );
            }
            const { preset } = await saveFilterPresetLinearized({
              projectId: project.id,
              name: rest[0]!,
              state: parsedState.data
            });
            return {
              exitCode: 0,
              stdout: args.json
                ? formatFilterPresetCliJson({ preset })
                : `Saved preset "${escapeExternalInlineText(preset.name)}"`
            };
          }

          if (verb === 'rename') {
            if (rest.length !== 2) {
              throw new Error(
                'Usage: bb project-work presets rename <name> <new-name> ' +
                  '[--project <proj_id>] [--json]'
              );
            }
            const existing = resolvePresetByName(project.id, rest[0]!);
            const { preset } = await saveFilterPresetLinearized({
              projectId: project.id,
              id: existing.id,
              name: rest[1]!,
              state: existing.state
            });
            return {
              exitCode: 0,
              stdout: args.json
                ? formatFilterPresetCliJson({ preset })
                : `Renamed preset "${escapeExternalInlineText(existing.name)}" to "${escapeExternalInlineText(preset.name)}"`
            };
          }

          if (verb === 'delete') {
            if (rest.length !== 1) {
              throw new Error(
                'Usage: bb project-work presets delete <name> ' +
                  '[--project <proj_id>] [--json]'
              );
            }
            const existing = resolvePresetByName(project.id, rest[0]!);
            const presets = store.deleteFilterPreset(project.id, existing.id);
            publishFilterPresetsChanged(project.id);
            return {
              exitCode: 0,
              stdout: args.json
                ? formatFilterPresetCliJson({ presets })
                : `Deleted preset "${escapeExternalInlineText(existing.name)}"`
            };
          }
        }
        throw new Error('Unknown bb project-work command');
      } catch (error) {
        return { exitCode: 1, stderr: `${errorMessage(error)}\n` };
      }
    }
  });

  async function configuredLiveProjectIds(): Promise<string[]> {
    const liveProjectIds = new Set(
      (await listProjects()).map(project => project.id)
    );
    return store
      .connectedProjectIds()
      .filter(projectId => liveProjectIds.has(projectId));
  }

  async function migrateLegacyCredential(
    source: CredentialSource,
    liveProjectIds: ReadonlySet<string>
  ): Promise<void> {
    const selectedProjectIds = store
      .connectedProjectIds(source)
      .filter(projectId => liveProjectIds.has(projectId));
    const connectorStates = await Promise.all(
      selectedProjectIds.map(async projectId => ({
        projectId,
        credentialConfigured: await credentials.configured(projectId, source),
        scopeConfigured: (() => {
          const entry = store.projectSource(projectId, source);
          return source === 'linear'
            ? Boolean(entry?.source === 'linear' && entry.teamKey)
            : Boolean(
                entry?.source === 'jira' && entry.baseUrl && entry.email
              );
        })()
      }))
    );
    const unavailableProjectIds = connectorStates
      .filter(entry => !entry.credentialConfigured || !entry.scopeConfigured)
      .map(entry => entry.projectId);

    if (selectedProjectIds.length !== 1) {
      if (selectedProjectIds.length > 1) {
        for (const projectId of unavailableProjectIds) {
          invalidateSource(projectId, source);
        }
        await Promise.all(
          unavailableProjectIds.map(projectId =>
            enqueueMutation(projectId, [source], async () => undefined)
          )
        );
      }
      const result = await credentials.migrateLegacy(
        source,
        selectedProjectIds
      );
      if (result.outcome === 'ambiguous-projects') {
        bb.log.warn(
          `${sourceName(source)} legacy credential needs manual project assignment`
        );
      }
      return;
    }

    const projectId = selectedProjectIds[0]!;
    if (source === 'jira') {
      const entry = store.projectSource(projectId, 'jira');
      const jira = entry?.source === 'jira' ? entry : undefined;
      if (!jira?.baseUrl || !jira.email) {
        invalidateSource(projectId, source);
        await enqueueMutation(projectId, [source], async () => undefined);
        const result = await credentials.migrateLegacy(source, []);
        if (result.outcome === 'no-eligible-project') {
          bb.log.warn(
            'Jira legacy credential was preserved because the enabled project needs a Jira URL and email; assign the full credential bundle in Manage'
          );
        }
        return;
      }
    }
    if (unavailableProjectIds.includes(projectId)) {
      invalidateSource(projectId, source);
    }
    await enqueueMutation(projectId, [source], async () => {
      const result = await credentials.migrateLegacy(source, [projectId]);
      if (
        result.outcome === 'migrated' ||
        result.outcome === 'already-migrated'
      ) {
        bb.realtime.publish('taskboard:changed', {
          projectId,
          source
        });
      } else if (result.outcome === 'destination-conflict') {
        bb.log.warn(
          `${sourceName(source)} legacy credential conflicts with the configured project credential`
        );
      }
    });
  }

  async function migrateLegacyCredentials(): Promise<void> {
    await withExclusiveMigration(async () => {
      const liveProjectIds = new Set(
        (await listProjects()).map(project => project.id)
      );
      for (const source of CREDENTIAL_SOURCES) {
        await migrateLegacyCredential(source, liveProjectIds);
      }
    });
  }

  bb.background.service('sync', {
    async start(signal) {
      let legacyIssueDraftCleanupFinished = false;
      let legacyMigrationFinished = false;
      let githubBootstrapFinished = false;
      while (!signal.aborted) {
        if (!githubBootstrapFinished) {
          try {
            const withRepos = (await workspace.read())
              .filter(
                entry => entry.bbProjectId && entry.repositories.length > 0
              )
              .map(entry => entry.bbProjectId!);
            const enabled = store.bootstrapGithubSources([...new Set(withRepos)]);
            if (enabled.length) {
              bb.log.info(`GitHub Issues включены для: ${enabled.join(', ')}`);
            }
            githubBootstrapFinished = true;
          } catch (error) {
            bb.log.warn(
              `GitHub Issues bootstrap deferred: ${errorMessage(error)}`
            );
          }
        }
        if (!legacyIssueDraftCleanupFinished) {
          try {
            await cleanupLegacyIssueDraftHelpers(bb);
            legacyIssueDraftCleanupFinished = true;
          } catch (error) {
            bb.log.warn(
              `Legacy issue-draft cleanup deferred: ${errorMessage(error)}`
            );
          }
        }
        if (!legacyMigrationFinished) {
          try {
            await migrateLegacyCredentials();
            legacyMigrationFinished = true;
          } catch (error) {
            bb.log.warn(
              `Legacy credential migration deferred: ${errorMessage(error)}`
            );
          }
        }
        try {
          const projectIds = await configuredLiveProjectIds();
          await Promise.all(
            projectIds.map(projectId => syncAll(projectId, undefined, false))
          );
        } catch (error) {
          bb.log.warn(`Background sync failed: ${errorMessage(error)}`);
        }
        await sleep(SYNC_INTERVAL_MS, signal);
      }
    }
  });

  bb.log.info(
    'Taskboard registered project-scoped Linear, GitHub, and Jira sources'
  );
}
