"""Conservative CI selection from the Git ranges provided by Actions."""
import json
import os
from pathlib import Path
import re
import subprocess
from ci_versions import coherent_version_paths, git, metadata_paths, version_only

PLUGINS = ['account-pool-balanced', 'automation-catalog', 'vpn-guard', 'oxi-projects',
           'model-connections', 'federation-pilot', 'pool-maintenance']
REQUIRED_CHECK_PLUGINS = {'account-pool-balanced', 'automation-catalog'}
# The hub uses portable Node HTTP APIs. Its server suite uses injected host
# services or localhost. Host entrypoints and their own suites stay on Mac.
PORTABLE = {'balancer', 'account-policy', 'project-policy', 'purpose-affinity',
            'provider-budget', 'codex-budget', 'zai-budget', 'usage-error', 'hub'}
# OP's native task integration fixture loads these Pooler modules directly.
OP_POOL_MODULES = {'native-sessions', 'native-probe-wire', 'native-accounts', 'native-quota-wire',
                   'native-unlock-rpc', 'contracts', 'project-policy', 'network-errors'}


POOL = 'plugins/account-pool-balanced/'
CURSOR_WRAPPER = POOL + 'scripts/cursor-route.py'
CURSOR_TEST = 'scripts/test_cursor_route.py'
# The Python harness runs the launcher against a fake HTTP server.
# BB and standalone Cursor HTTP contracts are exercised by the Pool package.
CURSOR_UNRELATED_PYTHON = {
    POOL + 'scripts/claude-host-doctor.py',
    POOL + 'scripts/test_claude_host_doctor.py',
}
UPGRADE_INPUTS = {'scripts/upgrade-pool.sh', 'scripts/upgrade-protection.sh',
                  'scripts/upgrade_pool.py', 'scripts/upgrade_pool_sandbox.py',
                  'scripts/pool_session_pause.py', 'scripts/pool_candidate_preflight.py',
                  'scripts/test_pool_candidate_preflight.py'}
TAG_VERSION = re.compile(r'([a-z0-9-]+)/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)')
KNOWN_PLUGINS = set(PLUGINS) | {'oxi-op', 'auto-archive', 'oxi-thread-list', 'oxi-provider-icons'}


def cursor_required(paths, version_paths=()):
    if metadata_paths(paths) - set(version_paths):
        return True
    for path in paths:
        if path in version_paths:
            continue
        if path == CURSOR_TEST:
            return True
        if (path.startswith(POOL + 'scripts/') and path.endswith('.py')
                and path not in CURSOR_UNRELATED_PYTHON):
            return True
        if path in UPGRADE_INPUTS or re.fullmatch(r'scripts/test_upgrade_[^/]+\.py', path):
            continue
        if path.endswith('.md') and not path.startswith('.github/'):
            continue
        parts = path.split('/')
        if len(parts) > 2 and parts[0] == 'plugins' and parts[1] in KNOWN_PLUGINS:
            continue
        return True
    return False


def mac_required(path):
    # The settings suite covers a macOS timing regression in Codex device login.
    if path == POOL + 'app.test.tsx':
        return True
    if path == POOL + 'src/server.test.ts':
        return False
    name = Path(path).name
    if any(word in name for word in ('browser', 'host', 'launcher', 'native', 'device')):
        return True
    if path.startswith('plugins/account-pool-balanced/docs/'):
        return False
    if path.endswith(('.md', '.css', '.tsx')):
        return False
    if path.startswith('plugins/account-pool-balanced/src/'):
        return name.removesuffix('.ts').removesuffix('.test') not in PORTABLE
    return True


def plan(paths, full=False, version_plugin=None, version_paths=()):
    cursor = full or cursor_required(paths, version_paths)
    selected = set()
    mac = set()
    upgrade = False
    upgrade_mac = False
    op = archive = session_tree = provider_icons = False
    for path in paths:
        if path == CURSOR_TEST:
            continue
        if path in version_paths:
            selected.add(version_plugin)
            upgrade |= version_plugin == 'account-pool-balanced'
            continue
        parts = path.split('/')
        if path.endswith('.md') and not path.startswith('.github/'):
            continue
        if len(parts) > 2 and parts[0] == 'plugins' and parts[1] in PLUGINS:
            plugin = parts[1]
            selected.add(plugin)
            if plugin != 'account-pool-balanced' or mac_required(path):
                mac.add(plugin)
            if plugin == 'account-pool-balanced':
                if path != CURSOR_WRAPPER and (not path.endswith(('.css', '.tsx')) or path == POOL + 'pool-update-panel.tsx'):
                    upgrade = True
                    upgrade_mac |= mac_required(path)
                op |= path in {POOL + 'src/' + name + '.ts' for name in OP_POOL_MODULES}
        elif path.startswith('plugins/oxi-op/'):
            op = True
        elif path.startswith('plugins/auto-archive/'):
            archive = True
        elif path.startswith('plugins/oxi-thread-list/'):
            session_tree = True
        elif path.startswith('plugins/oxi-provider-icons/'):
            provider_icons = True
        else:
            # Includes workflow/planner/shared/lockfile changes and deleted paths.
            full = True
    if full:
        selected, mac = set(PLUGINS), set(PLUGINS)
        upgrade = upgrade_mac = op = archive = session_tree = provider_icons = True
    # Required branch-protection contexts must exist even for docs-only PRs.
    # Keep selection separate so these placeholder rows do no expensive work.
    matrix = [{'os': osname, 'plugin': plugin,
               'run': plugin in selected and (osname == 'ubuntu-latest' or plugin in mac)}
              for plugin in PLUGINS
              for osname in ['ubuntu-latest', 'macos-latest']
              if plugin in REQUIRED_CHECK_PLUGINS or
              (plugin in selected and (osname == 'ubuntu-latest' or plugin in mac))]
    return {'matrix': {'include': matrix}, 'check': bool(matrix),
            'upgrade': upgrade, 'upgrade_mac': upgrade_mac, 'op': op, 'archive': archive,
            'cursor': cursor, 'session_tree': session_tree, 'provider_icons': provider_icons}


def changed_paths(base, head):
    out = subprocess.run(['git', 'diff', '--no-renames', '--name-only', '-z',
                          base, head, '--'], check=True, capture_output=True, timeout=30)
    return [os.fsdecode(path) for path in out.stdout.split(b'\0') if path]


def linear_diff(base, head):
    if not base:
        return None
    try:
        if git('merge-base', base, head) == git('rev-parse', '--verify', base + '^{commit}'):
            return changed_paths(base, head)
    except subprocess.SubprocessError:
        # A missing object or an unreadable range must retain the full plan.
        pass
    return None


def tag_baseline(ref, head):
    tag = ref.removeprefix('refs/tags/')
    match = TAG_VERSION.fullmatch(tag)
    if not match:
        return None
    plugin = match[1]
    if plugin not in KNOWN_PLUGINS:
        return None
    version = tuple(map(int, match.groups()[1:]))
    try:
        target = git('rev-parse', '--verify', ref + '^{commit}')
        if target != git('rev-parse', '--verify', head + '^{commit}'):
            return None
        tags = git('tag', '--merged', target, '--list', plugin + '/v*').splitlines()
        previous = []
        for candidate in tags:
            match = TAG_VERSION.fullmatch(candidate)
            if match:
                previous.append((tuple(map(int, match.groups()[1:])), candidate))
        lower = [item for item in previous if item[0] < version]
        if lower:
            return 'refs/tags/' + max(lower)[1]
    except subprocess.SubprocessError:
        pass
    return None


def event_plan(event, ref, head, pr_base, push_before):
    if event == 'push' and ref == 'refs/heads/main':
        base = push_before
        paths = linear_diff(base, head)
        if paths is None:
            return plan([], full=True)
    elif event == 'pull_request':
        if not pr_base:
            raise SystemExit('Missing pull request base')
        base = git('merge-base', pr_base, head)
        paths = changed_paths(base, head)
    elif event == 'push' and ref.startswith('refs/tags/'):
        base = tag_baseline(ref, head)
        paths = linear_diff(base, head)
        if paths is None:
            return plan([], full=True)
    else:
        return plan([], full=True)

    plugin, versions, full = version_only(paths, base, head, PLUGINS)
    result = plan(paths, full, plugin, versions)
    # Other checks retain the full metadata fallback.
    result['cursor'] = cursor_required(
        paths, versions or coherent_version_paths(paths, base, head, KNOWN_PLUGINS))
    return result


if __name__ == '__main__':
    result = event_plan(os.environ.get('EVENT_NAME', ''), os.environ.get('GIT_REF', ''),
                        os.environ.get('DIFF_HEAD', 'HEAD'), os.environ.get('DIFF_BASE', ''),
                        os.environ.get('PUSH_BEFORE', ''))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key, value in result.items():
            output.write(f'{key}={json.dumps(value, separators=(",", ":"))}\n')
