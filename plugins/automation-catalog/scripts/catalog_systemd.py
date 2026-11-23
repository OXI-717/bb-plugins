"""Read explicitly selected systemd timers; never starts or changes a unit."""
import datetime
import json
import os
import re
import subprocess
import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def timestamp(value):
    try:
        parts = value.split()
        wall = datetime.datetime.fromisoformat(parts[1] + 'T' + parts[2])
        return int(wall.replace(tzinfo=datetime.timezone.utc if parts[3] == 'UTC' else ZoneInfo(parts[3])).timestamp() * 1000)
    except (ValueError, IndexError, ZoneInfoNotFoundError):
        return None


def properties(command, scope, unit):
    prefix = ['systemctl'] + (['--user'] if scope == 'user' else [])
    keys = ['Id', 'LoadState', 'UnitFileState', 'ActiveState', 'Result',
            'ExecMainCode', 'ExecMainStatus', 'ExecMainStartTimestamp',
            'ExecMainExitTimestamp', 'InvocationID', 'NextElapseUSecRealtime',
            'TimersCalendar', 'LastTriggerUSec']
    output = command(prefix + ['show', unit, '--no-pager', '--property=' + ','.join(keys)],
                     env=dict(os.environ, TZ='UTC', LC_ALL='C'))
    return dict(line.split('=', 1) for line in output.splitlines() if '=' in line)


def collect(host, selection, command, task_base):
    if not isinstance(selection, dict) or not 1 <= len(selection) <= 100:
        raise ValueError('Select between 1 and 100 exact timers')
    tasks, runs = [], []
    for identifier, config in selection.items():
        if not isinstance(identifier, str) or not re.fullmatch(r'(system|user):[a-zA-Z0-9_.@:-]+\.(timer|service)', identifier):
            raise ValueError('Selection must name an exact system: or user: timer')
        scope, timer = identifier.split(':', 1)
        is_timer = timer.endswith('.timer')
        if not isinstance(config, dict) or set(config) - {'name', 'service', 'projectId'}:
            raise ValueError('Expected name/service/projectId selection object')
        service = config.get('service', timer[:-6] + '.service' if is_timer else timer)
        if not is_timer and service != timer:
            raise ValueError('Standalone service must match its identity')
        if is_timer and scope + ':' + service in selection:
            raise ValueError('Timer and companion service must have one card')
        if not isinstance(service, str) or not re.fullmatch(r'[a-zA-Z0-9_.@:-]+\.service', service):
            raise ValueError('Select an exact service')
        name = config.get('name')
        if not isinstance(name, str) or not 1 <= len(name) <= 300:
            raise ValueError('Display name required')
        timer_state = properties(command, scope, timer)
        live = properties(command, scope, service) if is_timer else timer_state
        if timer_state.get('LoadState') != 'loaded' or live.get('LoadState') != 'loaded':
            raise ValueError('Selected timer/service not loaded')
        enabled = timer_state.get('UnitFileState', 'unknown')
        active = timer_state.get('ActiveState', 'unknown')
        state = 'unknown'
        if active == 'failed':
            state = 'failed'
        elif active == 'active' and (not is_timer or enabled in ('enabled', 'enabled-runtime')):
            state = 'active'
        elif enabled in ('disabled', 'masked', 'masked-runtime') and active == 'inactive':
            state = 'paused'
        task = task_base(identifier, name, host)
        task.update(scheduler='systemd', executor=service, projectId=config.get('projectId'),
                    state=state, declaredState=enabled, schedule=(timer_state.get('TimersCalendar') or None) if is_timer else None,
                    nextRunAt=timestamp(timer_state.get('NextElapseUSecRealtime', '')) if is_timer else None,
                    history='not-recorded',
                    description=f'{scope} {"timer" if is_timer else "service"}: enabled={enabled}, active={active}; service result={live.get("Result", "unknown")}.')
        started = timestamp(live.get('ExecMainStartTimestamp', ''))
        finished = timestamp(live.get('ExecMainExitTimestamp', ''))
        invocation = live.get('InvocationID', '')
        if re.fullmatch(r'[a-f0-9]{32}', invocation) and started is not None:
            if finished is not None and finished < started:
                finished = None  # A new invocation can retain the previous exit time.
            exit_code = None
            status = 'running' if finished is None and live.get('ActiveState') in ('activating', 'active') else 'unknown'
            if finished is not None and finished >= started:
                if live.get('ExecMainCode') == '1' and live.get('ExecMainStatus', '').isdigit():
                    exit_code = int(live['ExecMainStatus'])
                    status = 'succeeded' if exit_code == 0 and live.get('Result') == 'success' else 'failed'
                elif live.get('Result') not in (None, '', 'success'):
                    status = 'failed'
            summary = 'Latest retained service execution; earlier invocations may be unavailable.'
            try:
                journal = command(['journalctl'] + (['--user'] if scope == 'user' else []) +
                                  ['--unit=' + service, '--no-pager', '--quiet', '-o', 'json', '-n', '500', '--since=7 days ago'])
                counters = None
                for line in journal.splitlines():
                    try:
                        event = json.loads(line)
                        if not isinstance(event, dict):
                            continue
                        if event.get('_SYSTEMD_INVOCATION_ID') != invocation:
                            continue
                        data = json.loads(event.get('MESSAGE', ''))
                        fields = ('eligible', 'kept', 'removed', 'errors')
                        if isinstance(data, dict) and all(isinstance(data.get(k), list) for k in fields):
                            counters = {k: len(data[k]) for k in fields}
                            value = data.get('removed_allocated_bytes')
                            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                                counters['removed_allocated_bytes'] = value
                    except (ValueError, TypeError):
                        continue
                if counters is not None:
                    summary += ' Cleanup counters: ' + json.dumps(counters, sort_keys=True)
                else:
                    summary += ' Journal counters unavailable or empty.'
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                summary += ' Journal unavailable; outcome is from systemctl.'
            runs.append(dict(taskId=identifier, host=host, id='systemd:' + invocation,
                             observedAt=int(time.time()*1000), evidence='execution',
                             startedAt=started, finishedAt=finished, status=status,
                             exitCode=exit_code, summary=summary))
            task['history'] = 'available'
        tasks.append(task)
    return tasks, runs
