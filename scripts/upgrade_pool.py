#!/usr/bin/env python3
"""Safely update an installed local BB account pool via supported CLI commands."""
import argparse
import contextlib
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import select
import shutil
import sqlite3
import subprocess
import sys
import time
import traceback
import urllib.parse
import urllib.request

PLUGIN = 'account-pool-balanced'
REPO = 'https://github.com/OXI-717/bb-plugins.git'
PREFIX = PLUGIN + '/'
VERSION = re.compile(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)')


class UpgradeError(Exception):
    def __init__(self, message, detail=None):
        super().__init__(message)
        self.detail = detail


def version(value):
    if not VERSION.fullmatch(value):
        raise UpgradeError('Expected a stable X.Y.Z version')
    return tuple(map(int, value.split('.')))


def compatible(candidate, requested):
    mode = requested[:1] if requested[:1] in ('^', '~') else ''
    base = version(requested[1:] if mode else requested)
    value = version(candidate)
    if not mode:
        return value == base
    if mode == '~':
        ceiling = (base[0], base[1] + 1, 0)
    elif base[0]:
        ceiling = (base[0] + 1, 0, 0)
    elif base[1]:
        ceiling = (0, base[1] + 1, 0)
    else:
        ceiling = (0, 0, base[2] + 1)
    return base <= value < ceiling


def parse_tags(text, requested):
    tags = {}
    peeled = {}
    for line in text.splitlines():
        sha, ref = line.split()
        if not re.fullmatch(r'[a-f0-9]{40}', sha):
            raise UpgradeError('Invalid release commit')
        match = re.fullmatch(r'refs/tags/' + re.escape(PREFIX) + r'v(\d+\.\d+\.\d+)(\^\{\})?', ref)
        if match and compatible(match[1], requested):
            (peeled if match[2] else tags)[match[1]] = sha
    if not tags:
        raise UpgradeError('No stable release matches the installed source range')
    target = max(tags, key=version)
    return target, peeled.get(target, tags[target])


def run(*args, timeout=60):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # Never echo provider output or account data into a shared terminal.
        raise UpgradeError(f'{args[0]} {args[1]} failed (exit {result.returncode})', result.stderr[-16000:])
    return result.stdout


def bb(*args):
    return json.loads(run('bb', *args, '--json'))


def installed():
    matches = [p for p in bb('plugin', 'list')['plugins'] if p['id'] == PLUGIN]
    if len(matches) != 1 or not matches[0]['enabled']:
        raise UpgradeError('An enabled account-pool-balanced installation is required')
    return matches[0]


def source_info():
    source = bb('plugin', 'source', PLUGIN)
    expected = 'git:' + REPO + '@semver:' + PREFIX + ':' + str(source.get('range'))
    if (source.get('requested') != expected or source.get('tagPrefix') != PREFIX
            or source.get('subdirectory') != 'plugins/' + PLUGIN):
        raise UpgradeError('Unsupported source: expected this repository and a per-plugin semver range')
    compatible('0.0.0', source['range'])  # Validate the supported range syntax.
    return source


def release_target(source, expected=None):
    target, sha = parse_tags(run('git', 'ls-remote', '--tags', REPO, 'refs/tags/' + PREFIX + 'v*'), source['range'])
    if expected is not None and target != expected:
        raise UpgradeError(f'BB would select {target}, not requested {expected}; nothing updated')
    url = 'https://api.github.com/repos/OXI-717/bb-plugins/releases/tags/' + urllib.parse.quote(PREFIX + 'v' + target, safe='')
    request = urllib.request.Request(url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'bb-pool-upgrade'})
    with urllib.request.urlopen(request, timeout=30) as response:
        release = json.load(response)
    if (release.get('tag_name') != PREFIX + 'v' + target or release.get('draft')
            or release.get('prerelease') or release.get('immutable') is not True):
        raise UpgradeError('BB would select a tag without a published immutable stable release; cannot safely fall back because BB update has no version selector')
    return target, sha


def inventory(pool):
    fields = ('id', 'provider', 'kind', 'enabled', 'priority', 'role', 'cap', 'policy', 'drainOnce', 'drainGeneration')
    return {
        'accounts': sorted(({k: a.get(k) for k in fields} for a in pool['accounts']), key=lambda a: a['id']),
        'routing': pool['routing'],
        'enabledAccountCount': pool['enabledAccountCount'],
    }


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    path.chmod(0o600)


def report_pool(pool, say):
    say(f"In-flight requests: {pool['inFlight']}")
    names = {h['hostId']: h.get('hostName') or h['hostId'] for h in pool.get('hosts', [])}
    for account in pool['accounts']:
        if account.get('inFlight', 0):
            host = account.get('lastUsedHostId')
            say(f"  {account['provider']} · account {account['id']} · requests {account['inFlight']} · last host: {names.get(host, host or 'unknown')} (not an exact request owner)")
    try:
        active = [t for t in bb('thread', 'list', '--include-hidden') if t.get('status') == 'active']
        say('Active BB threads (not exact request attribution): ' + (', '.join(t['id'] for t in active) or 'none'))
    except (UpgradeError, ValueError, KeyError, subprocess.TimeoutExpired):
        say('Thread list unavailable; pool request count remains authoritative.')


def confirm_interrupt():
    try:
        with open('/dev/tty', 'r') as terminal, open('/dev/tty', 'w') as terminal_out:
            terminal_out.write('Interrupt ALL remaining pool requests during update? Type yes within 60 seconds: ')
            terminal_out.flush()
            if select.select([terminal], [], [], 60)[0]:
                return terminal.readline().strip().lower() in ('yes', 'да')
    except OSError:
        pass
    return False


def wait_idle(say, prompt_now=False):
    start = time.monotonic()
    next_report = start
    stable = 0
    asked = False
    while time.monotonic() - start < 900:
        pool = bb('pool', 'status')
        count = pool['inFlight']
        if not isinstance(count, int) or isinstance(count, bool) or count < 0:
            raise UpgradeError('Invalid in-flight request count')
        stable = stable + 1 if count == 0 else 0
        if stable == 3:
            say('Pool idle: three checks passed.')
            return False
        now = time.monotonic()
        if now >= next_report:
            say(f'Idle wait: {int(now - start)} / 900 seconds')
            report_pool(pool, say)
            next_report = now + 60
        if count and not asked and (prompt_now or now - start >= 300):
            asked = True
            if confirm_interrupt():
                say('Explicit interruption confirmed; remaining pool requests may be aborted by BB.')
                return True
            say('No interruption approved; continuing to wait up to 15 minutes.')
        time.sleep(3)
    raise UpgradeError('Idle wait expired; nothing updated')


def backup_state(data, destination, pool, source, info, config):
    destination.mkdir(mode=0o700)
    database = data / 'data.db'
    with contextlib.closing(sqlite3.connect(database.as_uri() + '?mode=ro', uri=True)) as src:
        with contextlib.closing(sqlite3.connect(destination / 'data.db')) as dst:
            src.backup(dst)
            if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise UpgradeError('Backup database integrity check failed')
    if (data / 'secrets').exists():
        shutil.copytree(data / 'secrets', destination / 'secrets')
    for path in destination.rglob('*'):
        path.chmod(0o700 if path.is_dir() else 0o600)
    save_json(destination / 'state.json', inventory(pool))
    save_json(destination / 'source.json', source)
    save_json(destination / 'installed.json', info)
    save_json(destination / 'config.json', config)
    (destination / 'RECOVERY.txt').write_text(
        'Do not remove the plugin: BB removal deletes state.\n'
        'Do not copy data.db over a running BB server.\n'
        'This directory contains an online SQLite backup, secrets, configuration and previous source metadata.\n'
        'For recovery: stop BB using its normal host service controls; preserve the failed plugin directory; '
        'restore this data.db and secrets directory to the original plugin data directory; '
        'restore a compatible previous plugin build using supported BB recovery tooling before restarting.\n'
        'BB CLI currently has no arbitrary-version downgrade command; if a migration is incompatible, '
        'keep BB stopped and use the saved source metadata with BB support. No destructive reinstall is automated.\n')


def perform(args, data, output, say):
    info = installed()
    source = source_info()
    target, sha = release_target(source, args.version)
    say(f"Installed {info['version']}; selected {target}; commit {sha}")
    if version(target) < version(info['version']):
        raise UpgradeError('Downgrades are not supported')
    if args.check:
        report_pool(bb('pool', 'status'), say)
    if target == info['version']:
        if not source.get('history') or source['history'][0]['version'] != sha:
            raise UpgradeError('Installed version matches but resolved commit differs')
        say('Already up to date.')
        return 'ALREADY_CURRENT'
    if args.check:
        say('Preflight passed; no update performed.')
        return 'PREFLIGHT_PASS'
    forced = wait_idle(say, args.interrupt_now)
    before = bb('pool', 'status')
    config = bb('plugin', 'config', PLUGIN)['values']
    if not before['accepting'] or (before['inFlight'] and not forced):
        raise UpgradeError('Pool state changed; retry after requests finish')
    backup_state(data, output / 'backup', before, source, info, config)
    say('Verified backup created.')
    # Fail closed if a new release or a source/settings change appeared while waiting.
    if source_info() != source or release_target(source, target) != (target, sha):
        raise UpgradeError('Source or release changed while waiting; nothing updated')
    latest = bb('pool', 'status')
    if inventory(latest) != inventory(before) or bb('plugin', 'config', PLUGIN)['values'] != config:
        raise UpgradeError('Account settings changed during backup; retry')
    if latest['inFlight'] and not forced:
        raise UpgradeError('New requests arrived during backup; retry')
    say(f'Updating to {target} using BB plugin update.')
    run('bb', 'plugin', 'update', PLUGIN, '--yes', timeout=600)
    after_info = installed()
    after_source = source_info()
    after = bb('pool', 'status')
    if (after_info['version'] != target or not after_source.get('history')
            or after_source['history'][0]['version'] != sha):
        raise UpgradeError('Updated version or commit differs from verified release; inspect backup/RECOVERY.txt')
    if not after['accepting'] or inventory(after) != inventory(before):
        raise UpgradeError('Post-update account or routing verification failed; inspect backup/RECOVERY.txt')
    after_config = bb('plugin', 'config', PLUGIN)['values']
    if any(after_config.get(key) != value for key, value in config.items()):
        raise UpgradeError('Pool configuration changed unexpectedly; inspect backup/RECOVERY.txt')
    with contextlib.closing(sqlite3.connect((data / 'data.db').as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise UpgradeError('Post-update database integrity check failed')
    say('PASS: version, commit, accounts, routing, configuration and database verified.')
    return 'PASS'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate release without waiting or updating')
    parser.add_argument('--version', help='Require this to be the latest compatible release; not a downgrade selector')
    parser.add_argument('--interrupt-now', action='store_true', help='Offer the interactive interruption prompt immediately')
    parser.add_argument('--sandbox', action='store_true', help='Exercise the full workflow on temporary synthetic state; no live BB or network')
    args = parser.parse_args()
    if args.sandbox:
        if args.version or args.check or args.interrupt_now:
            parser.error('--sandbox cannot be combined with live-operation options')
        from upgrade_pool_sandbox import sandbox
        return sandbox(sys.modules[__name__])
    os.umask(0o077)
    output = None
    try:
        if args.version:
            version(args.version)
        remote = urllib.parse.urlsplit(os.environ.get('BB_SERVER_URL', 'http://127.0.0.1'))
        if remote.hostname not in ('localhost', '127.0.0.1', '::1'):
            raise UpgradeError('Run this script on the BB server host with a local BB connection')
        root = Path(bb('status')['dataDir']).resolve()
        data = root / 'plugins' / PLUGIN
        if not (data / 'data.db').is_file():
            raise UpgradeError('Local plugin database not found; run on the BB server host')
        backups = root / 'backups'
        backups.mkdir(mode=0o700, exist_ok=True)
        with (backups / (PLUGIN + '-upgrade.lock')).open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise UpgradeError('Another pool upgrade is already running') from None
            stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
            output = backups / f'{PLUGIN}-upgrade-{stamp}-{os.getpid()}'
            output.mkdir(mode=0o700)
            print(f'Backup and log: {output}', flush=True)
            with (output / 'upgrade.log').open('w') as log:
                def say(message):
                    print(message, flush=True)
                    log.write(message + '\n')
                    log.flush()
                try:
                    result = perform(args, data, output, say)
                except (Exception, KeyboardInterrupt) as error:
                    message = 'Cancelled by user' if isinstance(error, KeyboardInterrupt) else str(error)
                    say('FAILED: ' + type(error).__name__ + ': ' + message)
                    traceback.print_exc(file=log)
                    log.flush()
                    if isinstance(error, UpgradeError) and error.detail:
                        log.write('Command diagnostics (private):\n' + error.detail + '\n')
                        log.flush()
                    raise
                (output / 'result').write_text(result + '\n')
        return 0
    except (Exception, KeyboardInterrupt) as error:
        if output:
            (output / 'result').write_text('FAILED\n')
            print(f'No automatic rollback performed. Log and recovery files: {output}', file=sys.stderr)
        else:
            print(f'FAILED: {error}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
