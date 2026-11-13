"""Conservative PR selection; unknown paths retain the complete matrix."""
import json
import os
from pathlib import Path
import subprocess
from ci_versions import git, version_only

PLUGINS = ['account-pool-balanced', 'automation-catalog', 'vpn-guard', 'oxi-projects',
           'model-connections', 'federation-pilot', 'pool-maintenance']
PORTABLE = {'balancer', 'account-policy', 'project-policy', 'purpose-affinity',
            'provider-budget', 'codex-budget', 'zai-budget', 'usage-error'}


def mac_required(path):
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
    selected = set()
    mac = set()
    upgrade = False
    upgrade_mac = False
    op = archive = False
    for path in paths:
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
                upgrade = True
                upgrade_mac |= mac_required(path)
        elif path.startswith('plugins/oxi-op/'):
            op = True
        elif path.startswith('plugins/auto-archive/'):
            archive = True
        else:
            # Includes workflow/planner/shared/lockfile changes and deleted paths.
            full = True
    if full:
        selected, mac = set(PLUGINS), set(PLUGINS)
        upgrade = upgrade_mac = op = archive = True
    matrix = [{'os': osname, 'plugin': plugin} for plugin in PLUGINS if plugin in selected
              for osname in ['ubuntu-latest', 'macos-latest']
              if osname == 'ubuntu-latest' or plugin in mac]
    return {'matrix': {'include': matrix}, 'check': bool(matrix),
            'upgrade': upgrade, 'upgrade_mac': upgrade_mac, 'op': op, 'archive': archive}


if __name__ == '__main__':
    base, head = os.environ.get('DIFF_BASE', ''), os.environ.get('DIFF_HEAD', 'HEAD')
    full = os.environ.get('EVENT_NAME') != 'pull_request'
    ref = os.environ.get('GIT_REF', '')
    if ref.startswith('refs/tags/') and '/v' in ref:
        tag = ref.removeprefix('refs/tags/')
        prefix = tag.rsplit('/v', 1)[0]
        tags = subprocess.run(['git', 'tag', '--merged', head, '--list',
                               prefix + '/v*', '--sort=-version:refname'],
                              check=True, capture_output=True, text=True, timeout=30).stdout.splitlines()
        previous = [value for value in tags if value != tag]
        if previous:
            base, full = previous[0], False
    paths = []
    version_plugin, version_paths = None, set()
    if not full:
        if not base:
            raise SystemExit('Missing pull request base')
        base = git('merge-base', base, head)
        out = subprocess.run(['git', 'diff', '--no-renames', '--name-only', '-z',
                              base + '...' + head], check=True, capture_output=True,
                             text=True, timeout=30)
        paths = [p for p in out.stdout.split('\0') if p]
        version_plugin, version_paths, metadata_full = version_only(paths, base, head, PLUGINS)
        full |= metadata_full
    result = plan(paths, full, version_plugin, version_paths)
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        for key, value in result.items():
            output.write(f'{key}={json.dumps(value, separators=(",", ":"))}\n')
