#!/usr/bin/env python3
"""Check the unified candidate against both public branch tips, without installation.

Run before merging with --tree HEAD to demonstrate the missing main features.
An optional private --inventory JSON list of {id, version} adds installed floors;
it is read in place and never emitted or copied into the repository.
"""
import argparse
import json
from pathlib import Path
import subprocess


def read(path, tree=None):
    if tree:
        result = subprocess.run(['git', 'show', f'{tree}:{path}'], capture_output=True, text=True)
        return result.stdout if result.returncode == 0 else ''
    p = Path(path)
    return p.read_text() if p.exists() else ''


def version(value):
    return tuple(map(int, value.lstrip('^~v').split('.')))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tree')
    parser.add_argument('--main-ref', default='origin/main')
    parser.add_argument('--release-ref', default='origin/release/account-pool-0.4.x')
    parser.add_argument('--inventory')
    args = parser.parse_args()
    failures = []
    catalog = json.loads(read('marketplace.json', args.tree))
    inventory = {}
    if args.inventory:
        inventory = {p['id']: p['version'] for p in json.loads(Path(args.inventory).read_text())}
    for entry in catalog['plugins']:
        plugin = entry['id']
        path = f'plugins/{plugin}/package.json'
        current = json.loads(read(path, args.tree))['version']
        floors = [inventory[plugin]] if plugin in inventory else []
        for ref in (args.main_ref, args.release_ref):
            source = read(path, ref)
            if source:
                floors.append(json.loads(source)['version'])
        if plugin == 'account-pool-balanced':
            floors.append('0.4.92')
        if plugin == 'vpn-guard':
            floors.append('0.1.24')
        if any(version(current) < version(floor) for floor in floors):
            failures.append(f'{plugin}: package below required floor')
        if version(entry['source']['git']['range']) < version(current):
            failures.append(f'{plugin}: marketplace below package')
        lock = json.loads(read(f'plugins/{plugin}/package-lock.json', args.tree))
        if lock['version'] != current or lock['packages']['']['version'] != current:
            failures.append(f'{plugin}: lock version mismatch')
    # Cross-branch seams: Grok must coexist with release-only native probes,
    # manual selection, diagnostics and the newer VPN observation grace.
    checks = {
        'plugins/account-pool-balanced/src/host.ts': ['grokHome:', 'nativeProbeCapabilities:', 'nativeProbe:'],
        'plugins/account-pool-balanced/src/server.ts': ['egress,grokLogin,()=>nativeSessions.accounts()', 'nativeSessions.probe(', 'selection)', 'registerUsageSource(bb, hub, false)'],
        'plugins/account-pool-balanced/src/cli.ts': ['grokLogin', 'nativePreflight'],
        'plugins/account-pool-balanced/app.tsx': ['"grok-login"', 'NativeAccountCard', 'thread.switchAccount'],
        'plugins/account-pool-balanced/src/grok-acp-home.ts': ['ensureGrokAcpHome'],
        'plugins/account-pool-balanced/src/loop-delay.ts': [''],
        'plugins/vpn-guard/observation-grace.test.ts': [''],
        'plugins/oxi-thread-list/package.json': ['bb-plugin-oxi-thread-list'],
        'AGENTS.md': ['pull requests target `main`', 'GitHub releases from `main`', 'matching package version', 'standard updater'],
    }
    for path, needles in checks.items():
        source = read(path, args.tree)
        if not source or any(needle not in source for needle in needles):
            failures.append(f'{path}: missing integration behavior')
    rules = read('AGENTS.md', args.tree).splitlines()
    bullets = [line for line in rules if line.startswith('- ')]
    if len(bullets) != len(set(bullets)):
        failures.append('AGENTS.md: duplicate rules')
    if failures:
        print('\n'.join(failures))
        return 1
    print('OK: both branch features, package/lock/catalog floors and release rules preserved')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
