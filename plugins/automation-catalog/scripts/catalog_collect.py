import argparse
import datetime
import getpass
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import socket
import subprocess
import sys
import tempfile
import time

from catalog_history import LaunchLedger, launch_events, read_receipts


def command(argv, env=None):
    result = subprocess.run(argv, capture_output=True, text=True, timeout=30, env=env)
    if result.returncode:
        raise RuntimeError('Source command failed: ' + Path(argv[0]).name)
    if len(result.stdout) > 8_000_000:
        raise RuntimeError('Source response exceeds 8 MB')
    return result.stdout


def task_base(identifier, name, host):
    return dict(id=identifier, name=name[:300], host=host, scope='unknown', owner=None,
                team=None, projectId=None, scheduler='unknown', executor='Unknown',
                schedule=None, state='unknown', description='', history='not-connected', url=None)


def cron_tasks(content, host, owner):
    result = []
    seen = set()
    timezone = 'host timezone'
    for line in content.splitlines():
        line = line.strip()
        if line.startswith('CRON_TZ='):
            timezone = line.split('=', 1)[1].strip().strip('"\'')
        if not line or line.startswith('#') or re.match(r'^\w+\s*=', line):
            continue
        parts = line.split(None, 1 if line.startswith('@') else 5)
        if len(parts) not in (2, 6):
            continue
        schedule, invocation = ' '.join(parts[:-1]), parts[-1]
        digest = hashlib.sha256((timezone + '\n' + line).encode()).hexdigest()[:24]
        if digest in seen:
            continue
        seen.add(digest)
        try:
            tokens = shlex.split(invocation)
            while tokens and re.match(r'^[A-Za-z_]\w*=', tokens[0]):
                tokens.pop(0)
            executable = Path(tokens[0]).name
        except (ValueError, IndexError):
            executable = 'Cron job'
        marker = re.search(r'# bb-catalog-task=(cron:[a-f0-9]{24});name=([A-Za-z0-9_.-]+)$', invocation)
        identifier = marker[1] if marker and 'catalog_receipt_run.py' in invocation else 'cron:' + digest
        if marker and 'catalog_receipt_run.py' in invocation:
            executable = marker[2]
        task = task_base(identifier, executable, host)
        task.update(scope='personal', owner=owner, scheduler='cron', executor=executable,
                    schedule=schedule + ' (' + timezone + ')', history='not-recorded',
                    description='User crontab entry. Arguments are not exported. Execution outcomes are not recorded.')
        result.append(task)
    return result


def local_tasks(host, ledger=None, runs=None, boot=None, selection=None):
    selection = selection or {}
    tasks = []
    for folder, domain in [(Path.home() / 'Library/LaunchAgents', f'gui/{os.getuid()}'),
                           (Path('/Library/LaunchDaemons'), 'system')]:
        for path in sorted(folder.glob('*.plist')):
            if domain + ':' + path.stem not in selection:
                continue
            try:
                data = plistlib.loads(path.read_bytes())
            except (OSError, plistlib.InvalidFileException):
                task = task_base(domain + ':' + path.stem, path.stem, host)
                task.update(scheduler='launchd', description='Definition unreadable or broken link; state is unknown.')
                tasks.append(task)
                continue
            if not any(key in data for key in ('StartInterval', 'StartCalendarInterval', 'KeepAlive', 'RunAtLoad')):
                continue
            label = data.get('Label', path.stem)
            if domain + ':' + label not in selection:
                continue
            task = task_base(domain + ':' + label, selection[domain + ':' + label], host)
            task.update(scope='personal' if domain.startswith('gui/') else 'unknown',
                        owner=getpass.getuser() if domain.startswith('gui/') else None,
                        scheduler='launchd', history='not-recorded')
            arguments = data.get('ProgramArguments') or [data.get('Program', 'Unknown')]
            task['executor'] = Path(arguments[0]).name
            if data.get('StartCalendarInterval'):
                task['schedule'] = json.dumps(data['StartCalendarInterval'])[:2000] + ' (host timezone)'
            elif data.get('StartInterval'):
                task['schedule'] = f"Every {data['StartInterval']} seconds"
            elif data.get('KeepAlive'):
                task['schedule'] = 'KeepAlive service'
            elif data.get('RunAtLoad'):
                task['schedule'] = 'Run at load'
            try:
                output = command(['launchctl', 'print', domain + '/' + label])
                state = re.search(r'^\s*state = ([^\n]+)', output, re.M)
                exitcode = re.search(r'^\s*last exit code = ([^\n]+)', output, re.M)
                task['state'] = 'active'
                if ledger is not None:
                    properties = {}
                    for key in ('runs', 'state', 'pid', 'last exit code'):
                        match = re.search(r'^\s*' + re.escape(key) + r' = ([^\n]+)', output, re.M)
                        if match:
                            properties[key] = match[1].strip()
                    runs.extend(ledger.observe(host, task['id'], boot, properties))
                task['description'] = 'Loaded' + (': ' + state[1] if state else '')
                if exitcode:
                    task['description'] += '; last reported exit code: ' + exitcode[1]
                task['description'] += '. Launchd retains only the latest exit result; exact run timestamps may be unavailable.'
            except RuntimeError:
                task['description'] = 'Not loaded or inaccessible; execution state is unknown.'
            tasks.append(task)
    result = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=10)
    if result.returncode == 0:
        tasks.extend(dict(task, name=selection[task['id']]) for task in cron_tasks(result.stdout, host, getpass.getuser()) if task['id'] in selection)
    elif 'no crontab' not in result.stderr.lower():
        raise RuntimeError('Cannot read user crontab')
    return tasks


def local_collect(host, state_dir, log_file=None, selection=None):
    runs = []
    ledger = LaunchLedger(state_dir / 'launchd.sqlite3')
    try:
        boot = command(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid']).strip()
        tasks = local_tasks(host, ledger, runs, boot, selection)
    finally:
        ledger.close()
    task_ids = {task['id'] for task in tasks}
    try:
        content = Path(log_file).read_text() if log_file else command(['/usr/bin/log', 'show', '--style', 'ndjson', '--last', '20m', '--info', '--predicate', 'process == "launchd" AND eventMessage BEGINSWITH "service inactive:"'])
        events = []
        for line in content.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
        runs.extend(launch_events(events, task_ids, host))
        journal_ok = True
    except (OSError, RuntimeError, subprocess.TimeoutExpired):
        journal_ok = False
    runs.extend(read_receipts(state_dir / 'receipts', task_ids, host))
    populated = {run['taskId'] for run in runs}
    for task in tasks:
        if task['id'] in populated:
            task['history'] = 'available'
        if task['scheduler'] == 'launchd':
            task['description'] += ' History includes retained launchd results and explicit state-change events; intermediate exit results may be unavailable.'
            if not journal_ok:
                task['description'] += ' System journal could not be read this sync.'
        elif task['scheduler'] == 'cron' and (state_dir / 'commands' / (task['id'].replace(':', '-') + '.json')).exists():
            task['history'] = 'available'
            task['description'] = 'Future invocations write start, completion and exit-code receipts. Earlier cron results were not recorded.'
    return tasks, runs[-5000:]


def registry_tasks(data, team, include_private=False):
    tasks = []
    for item in data['automations']:
        if not include_private and item.get('visibility') not in ('team', 'team-metadata', 'aggregate-team'):
            continue
        runtime = item.get('runtime', {})
        task = task_base(item['id'], item.get('title') or item['id'], runtime.get('host_id') or 'Unknown')
        scope = item.get('scope', 'unknown')
        task.update(scope=scope if scope in ('personal', 'team') else 'unknown',
                    owner=item.get('owner', {}).get('human'), team=team if scope == 'team' else None,
                    scheduler=runtime.get('scheduler') or 'systemd', executor=runtime.get('unit') or 'Unknown',
                    schedule=json.dumps(item['schedule'], ensure_ascii=False) if item.get('schedule') else None,
                    declaredState=item.get('state'),
                    description='Registry metadata. Live execution status and history are not connected.')
        tasks.append(task)
    return tasks


def timestamp(value):
    if value is None:
        return None
    return int(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)


def aim_run(item, host, include_results):
    result = item.get('result')
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except ValueError:
            result = None
    if not isinstance(result, dict):
        result = {}
    summary = result.get('summary') or result.get('error')
    if include_results and not isinstance(summary, str):
        summary = json.dumps(result, ensure_ascii=False) if result else None
    state = item.get('state', 'unknown')
    return dict(taskId=item['task_id'], host=host, id=item['id'],
                status=state if state in ('queued', 'running', 'succeeded', 'failed', 'cancelled') else 'unknown',
                startedAt=timestamp(item.get('started_at')), finishedAt=timestamp(item.get('finished_at')),
                summary=summary[:8000] if include_results and isinstance(summary, str) else None,
                exitCode=result.get('exit_code') if isinstance(result.get('exit_code'), int) else None)


def aim_collect(host, scope, team, include_results):
    response = json.loads(command(['aim-auto', 'tasks']))
    if response.get('ok') is not True:
        raise RuntimeError('Scheduler task API failed')
    tasks = []
    for item in response['data']['tasks']:
        definition = item['definition']
        task = task_base(item['id'], definition.get('title') or item['id'], host)
        schedule = definition.get('schedule')
        task.update(scope=scope, owner=item.get('owner'), team=team if scope == 'team' else None,
                    scheduler='aim-auto', executor=definition.get('profile', 'Unknown'),
                    state='paused' if item['paused'] else 'active', history='available',
                    schedule=(schedule['cron'] + ' ' + schedule['timezone']) if schedule else None,
                    description='Scheduler server automation. Recent runs are imported; older history may remain only at the source.')
        tasks.append(task)
    response = json.loads(command(['aim-auto', 'runs', '--limit', '100']))
    if response.get('ok') is not True:
        raise RuntimeError('Scheduler history API failed')
    task_ids = {task['id'] for task in tasks}
    runs = [aim_run(item, host, include_results) for item in response['data']['runs'] if item['task_id'] in task_ids]
    return tasks, runs


def bb_collect(server, host):
    env = dict(os.environ, BB_SERVER_URL=server)
    def read(argv):
        return json.loads(command(['bb', *argv, '--json'], env=env))
    overview = read(['plugin', 'rpc', 'call', 'automations', 'automations_overview'])
    tasks, runs = [], []
    for entry in overview['automations']:
        item, project = entry['automation'], entry['project']
        execution = item.get('execution', {})
        task = task_base(item['id'], item['name'], host if execution.get('mode') == 'script' else 'BB-managed agent')
        trigger = item.get('trigger', {})
        schedule = ((trigger.get('cron', '') + ' ' + trigger.get('timezone', '')).strip()
                    if trigger.get('triggerType') == 'schedule' else datetime.datetime.fromtimestamp(trigger['runAt'] / 1000, datetime.timezone.utc).isoformat() if trigger.get('runAt') else 'Unknown schedule')
        task.update(scope='personal' if project['id'] == 'proj_personal' else 'unknown',
                    projectId=project['id'], scheduler='bb', executor=execution.get('interpreter') or execution.get('mode', 'Unknown'),
                    state='active' if item.get('enabled') else 'paused', schedule=schedule,
                    history='available', description='Managed by the connected BB instance. Project: ' + project['name'] + '. Read-only projection; schedules remain at the source.')
        tasks.append(task)
        history = read(['automation', 'runs', item['id'], '--project', project['id'], '--limit', '100'])
        for run in history['runs']:
            runs.append(dict(taskId=item['id'], host=task['host'], id=run['id'],
                             status=run['status'], startedAt=run.get('startedAt'), finishedAt=run.get('finishedAt'),
                             exitCode=run.get('exitCode'), summary=('Skipped: ' + run['skipReason']) if run.get('skipReason') else None))
    return tasks, runs


def main():
    parser = argparse.ArgumentParser(description='Read external automation metadata; never executes tasks or models.')
    parser.add_argument('kind', choices=['local', 'registry', 'aim', 'bb'])
    parser.add_argument('--source-id', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--host', help='Execution host for local or Scheduler API tasks')
    parser.add_argument('--registry', type=Path)
    parser.add_argument('--bb-server', help='Read-only source BB server URL; publication still uses the selected BB server')
    parser.add_argument('--scope', choices=['personal', 'team', 'unknown'], default=None)
    parser.add_argument('--team')
    parser.add_argument('--include-private-metadata', action='store_true', help='Include private registry entries; visible to everyone with access to the destination BB instance. Destination access is not verified.')
    parser.add_argument('--include-results', action='store_true', help='Include authorized Scheduler results in this trusted BB instance')
    parser.add_argument('--publish', action='store_true', help='Publish through the currently selected BB server')
    parser.add_argument('--selection', type=Path, help='Required local registry: JSON object mapping task IDs to display names')
    parser.add_argument('--state-dir', type=Path, default=Path.home() / '.local/state/bb-automation-catalog')
    parser.add_argument('--launch-log', type=Path, help='Import an existing launchd JSONL journal export')
    args = parser.parse_args()
    if (args.kind == "bb") != (args.bb_server is not None):
        parser.error("--bb-server is required for bb and only applies to bb")
    if args.kind == "bb" and not args.host:
        parser.error("--host is required for the BB server execution host")
    if (args.kind == "local") != (args.selection is not None):
        parser.error("--selection is required for local and only applies to local")
    if args.launch_log is not None and args.kind != 'local':
        parser.error('--launch-log only applies to local')
    if args.include_private_metadata and args.kind != 'registry':
        parser.error('--include-private-metadata only applies to registry')
    if args.include_results and args.kind != 'aim':
        parser.error('--include-results only applies to aim')
    if args.scope is not None and args.kind != 'aim':
        parser.error('--scope only applies to aim; other sources determine their own scope')
    if args.registry is not None and args.kind != 'registry':
        parser.error('--registry only applies to registry')
    if args.host is not None and args.kind == 'registry':
        parser.error('Registry hosts are defined in the registry')
    if args.team is not None and args.kind in ('local', 'bb'):
        parser.error('--team does not apply to local or BB schedules')
    if args.kind == 'aim' and not args.host:
        parser.error('--host is required for the Scheduler execution host')
    snapshot = dict(source=dict(id=args.source_id, name=args.name, staleAfterMs=7200000),
                    observedAt=int(time.time() * 1000), error=None, tasks=[], runs=[])
    try:
        if args.kind == 'local':
            selection = json.loads(args.selection.read_text())
            if not isinstance(selection, dict) or len(selection) > 2000 or any(not isinstance(k, str) or not 1 <= len(k) <= 300 or not isinstance(v, str) or not 1 <= len(v) <= 300 for k, v in selection.items()):
                raise ValueError('Invalid local selection registry')
            snapshot['source']['taskIds'] = list(selection)
            snapshot['tasks'], snapshot['runs'] = local_collect(args.host or socket.gethostname(), args.state_dir, args.launch_log, selection)
        elif args.kind == 'bb':
            snapshot['tasks'], snapshot['runs'] = bb_collect(args.bb_server, args.host)
        elif args.kind == 'registry':
            if not args.registry:
                parser.error('--registry is required')
            snapshot['tasks'] = registry_tasks(json.loads(args.registry.read_text()), args.team, args.include_private_metadata)
        else:
            snapshot['tasks'], snapshot['runs'] = aim_collect(args.host, args.scope or 'unknown', args.team, args.include_results)
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        snapshot['error'] = 'Source unavailable (' + type(error).__name__ + ')'
        snapshot['tasks'], snapshot['runs'] = [], []
    if args.publish:
        with tempfile.TemporaryDirectory(prefix='bb-catalog-') as directory:
            path = Path(directory) / 'snapshot.json'
            path.write_text(json.dumps(snapshot, ensure_ascii=False))
            path.chmod(0o600)
            command(['bb', 'plugin', 'rpc', 'call', 'automation-catalog', 'catalog_publish', '--input-file', str(path)])
        print(json.dumps(dict(source=args.source_id, tasks=len(snapshot['tasks']), runs=len(snapshot['runs']), error=snapshot['error'])))
    else:
        print(json.dumps(snapshot, ensure_ascii=False))
    return 1 if snapshot['error'] else 0


if __name__ == '__main__':
    sys.exit(main())
