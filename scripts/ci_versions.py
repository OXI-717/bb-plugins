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


def version_only(paths, base, head, plugins):
    candidates = [p for p in paths if p == 'marketplace.json' or
                  re.fullmatch(r'plugins/[^/]+/package(?:-lock)?\.json', p)]
    if not candidates:
        return None, set(), False
    identities = {p.split('/')[1] for p in candidates if p.startswith('plugins/')}
    # Any ambiguous/incomplete/malformed release vector keeps the full plan.
    if len(identities) != 1:
        return None, set(), True
    plugin = next(iter(identities))
    expected = {f'plugins/{plugin}/package.json', f'plugins/{plugin}/package-lock.json', 'marketplace.json'}
    code_plugins = {p.split('/')[1] for p in paths if p.startswith('plugins/')}
    if plugin != 'account-pool-balanced' or plugin not in plugins or set(candidates) != expected or code_plugins != {plugin}:
        return None, set(), True
    try:
        package = f'plugins/{plugin}/package.json'
        old, new = read_json(base, package), read_json(head, package)
        before, after = old['version'], new['version']
        if before == after or not all(isinstance(v, str) and re.fullmatch(r'\d+\.\d+\.\d+', v) for v in (before, after)):
            raise ValueError('Ambiguous version')
        if old['name'] != f'bb-plugin-{plugin}' or new['name'] != old['name']:
            raise ValueError('Different plugin identity')
        new['version'] = before
        if not same_json(old, new):
            raise ValueError('Package fields changed')
        lock = f'plugins/{plugin}/package-lock.json'
        old, new = read_json(base, lock), read_json(head, lock)
        if old['name'] != f'bb-plugin-{plugin}' or new['name'] != old['name'] or type(old['lockfileVersion']) is not int or old['lockfileVersion'] != 3:
            raise ValueError('Unexpected lock identity/schema')
        for doc, version in ((old, before), (new, after)):
            if doc['version'] != version or doc['packages']['']['version'] != version or doc['packages']['']['name'] != f'bb-plugin-{plugin}':
                raise ValueError('Incoherent lock version')
        new['version'] = before
        new['packages']['']['version'] = before
        if not same_json(old, new):
            raise ValueError('Lock/dependency fields changed')
        old, new = read_json(base, 'marketplace.json'), read_json(head, 'marketplace.json')
        for doc, version in ((old, before), (new, after)):
            if type(doc['schemaVersion']) is not int or doc['schemaVersion'] != 1 or not isinstance(doc['plugins'], list):
                raise ValueError('Unknown marketplace schema')
            ids = [row['id'] for row in doc['plugins']]
            if len(set(ids)) != len(ids) or ids.count(plugin) != 1:
                raise ValueError('Ambiguous marketplace identity')
            row = next(row for row in doc['plugins'] if row['id'] == plugin)
            source = row['source']['git']
            if source['subdir'] != f'plugins/{plugin}' or source['tagPrefix'] != plugin + '/' or source['range'] != '^' + version:
                raise ValueError('Incoherent marketplace version/identity')
        next(row for row in new['plugins'] if row['id'] == plugin)['source']['git']['range'] = '^' + before
        if not same_json(old, new):
            raise ValueError('Marketplace fields/inventory changed')
        return plugin, expected, False
    except (ValueError, KeyError, TypeError, StopIteration, subprocess.SubprocessError):
        return None, set(), True
