"""Recognize only a coherent, version-only public plugin release vector."""
import json
import re
import subprocess


def git(*args):
    return subprocess.run(['git', *args], check=True, capture_output=True,
                          text=True, timeout=30).stdout.strip()


def strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate JSON key')
        result[key] = value
    return result


def same_json(left, right):
    # Python considers True == 1; JSON schema/type changes must never compare equal.
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def read_json(revision, path):
    spec = revision + ':' + path
    size = int(git('cat-file', '-s', spec))
    if size > 2_000_000:
        raise ValueError('Metadata exceeds bounded read limit')
    return json.loads(git('show', spec), object_pairs_hook=strict_object)


def package_version_change(plugin, base, head):
    package = f'plugins/{plugin}/package.json'
    old, new = read_json(base, package), read_json(head, package)
    before, after = old['version'], new['version']
    if before == after or not all(isinstance(v, str) and re.fullmatch(r'\d+\.\d+\.\d+', v) for v in (before, after)):
        raise ValueError('Ambiguous version')
    identity = f'bb-plugin-{plugin}'
    if old['name'] != identity or new['name'] != identity:
        raise ValueError('Different plugin identity')
    new['version'] = before
    if not same_json(old, new):
        raise ValueError('Package fields changed')
    lock = f'plugins/{plugin}/package-lock.json'
    old, new = read_json(base, lock), read_json(head, lock)
    if old['name'] != identity or new['name'] != identity or type(old['lockfileVersion']) is not int or old['lockfileVersion'] != 3:
        raise ValueError('Unexpected lock identity/schema')
    for doc, version in ((old, before), (new, after)):
        if doc['version'] != version or doc['packages']['']['version'] != version or doc['packages']['']['name'] != identity:
            raise ValueError('Incoherent lock version')
    new['version'] = before
    new['packages']['']['version'] = before
    if not same_json(old, new):
        raise ValueError('Lock/dependency fields changed')
    return before, after


def release_versions(candidates, identities, base, head):
    expected = {'marketplace.json'} | {
        f'plugins/{plugin}/package{suffix}.json'
        for plugin in identities for suffix in ('', '-lock')
    }
    if set(candidates) != expected:
        raise ValueError('Incomplete version metadata')
    versions = {plugin: package_version_change(plugin, base, head) for plugin in sorted(identities)}
    old, new = read_json(base, 'marketplace.json'), read_json(head, 'marketplace.json')
    for index, doc in enumerate((old, new)):
        if type(doc['schemaVersion']) is not int or doc['schemaVersion'] != 1 or not isinstance(doc['plugins'], list):
            raise ValueError('Unknown marketplace schema')
        rows = {row['id']: row for row in doc['plugins']}
        if len(rows) != len(doc['plugins']):
            raise ValueError('Ambiguous marketplace identity')
        for plugin, pair in versions.items():
            source = rows[plugin]['source']['git']
            if source['subdir'] != f'plugins/{plugin}' or source['tagPrefix'] != plugin + '/' or source['range'] != '^' + pair[index]:
                raise ValueError('Incoherent marketplace version/identity')
            if index == 1:
                source['range'] = '^' + pair[0]
    if not same_json(old, new):
        raise ValueError('Marketplace fields/inventory changed')
    return expected


def metadata_paths(paths):
    return {p for p in paths if p == 'marketplace.json' or
            re.fullmatch(r'plugins/[^/]+/package(?:-lock)?\.json', p)}


def version_only(paths, base, head, plugins):
    candidates = metadata_paths(paths)
    if not candidates:
        return None, set(), False
    pool = 'account-pool-balanced'
    code_plugins = {p.split('/')[1] for p in paths if p.startswith('plugins/')}
    if pool not in plugins or code_plugins != {pool}:
        return None, set(), True
    try:
        return pool, release_versions(candidates, {pool}, base, head), False
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return None, set(), True


def coherent_version_paths(paths, base, head, plugins):
    """Recognize independent version bumps without changing other job selection."""
    candidates = metadata_paths(paths)
    identities = {p.split('/')[1] for p in candidates if p.startswith('plugins/')}
    if not identities or not identities <= set(plugins):
        return set()
    try:
        return release_versions(candidates, identities, base, head)
    except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return set()
