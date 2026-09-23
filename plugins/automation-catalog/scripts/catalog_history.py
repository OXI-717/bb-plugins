import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time


def receipt(task, host, identifier, status, code=None, started=None, finished=None, summary=None, evidence='execution'):
    return dict(taskId=task, host=host, id=identifier, status=status, startedAt=started,
                finishedAt=finished, exitCode=code, summary=summary, evidence=evidence,
                observedAt=int(time.time() * 1000))


class LaunchLedger:
    def __init__(self, path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(path)
        os.chmod(path, 0o600)
        self.db.execute('CREATE TABLE IF NOT EXISTS counters (task TEXT PRIMARY KEY, boot TEXT, counter INTEGER, generation INTEGER, running INTEGER)')

    def close(self):
        self.db.close()

    def observe(self, host, task, boot, properties):
        raw = properties.get('runs', '')
        if not raw.isdigit() or int(raw) == 0:
            return []
        counter = int(raw)
        running = properties.get('state') == 'running' or properties.get('pid', '').isdigit()
        key = host + ':' + task
        self.db.execute('BEGIN IMMEDIATE')
        try:
            old = self.db.execute('SELECT boot,counter,generation,running FROM counters WHERE task=?', (key,)).fetchone()
            generation = old[2] if old and old[0] == boot else 0
            if old and old[0] == boot and (counter < old[1] or (counter == old[1] and running and not old[3])):
                generation += 1
            self.db.execute('INSERT OR REPLACE INTO counters VALUES (?,?,?,?,?)', (key, boot, counter, generation, int(running)))
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        prefix = 'launchd:' + hashlib.sha256((boot + ':' + task + ':' + str(generation)).encode()).hexdigest()[:24]
        rows = []
        code = properties.get('last exit code', '')
        completed = counter - 1 if running else counter
        if completed > 0 and re.fullmatch(r'-?\d+', code):
            number = int(code)
            rows.append(receipt(task, host, prefix + ':' + str(completed), 'succeeded' if number == 0 else 'failed', number,
                                summary=f'launchd reported execution #{completed}, exit code {number}. Exact start and finish times are unavailable. This is the last retained result, not a complete backfill.'))
        elif completed > 0 and not running:
            rows.append(receipt(task, host, prefix + ':' + str(completed), 'unknown',
                                summary=f'launchd recorded {counter} executions. The last result and exact timestamps are unavailable.'))
        if running:
            rows.append(receipt(task, host, prefix + ':' + str(counter), 'running',
                                summary=f'launchd reports execution #{counter} running. PID {properties.get("pid", "unknown")}.'))
        return rows


def launch_events(events, task_ids, host):
    rows = []
    for event in events:
        match = re.fullmatch(r'service inactive: (.+)', event.get('eventMessage', ''))
        domain = re.match(r'^(gui/\d+|system)(?:\s|$)', event.get('subsystem', ''))
        if not match or not domain:
            continue
        task = domain[1] + ':' + match[1]
        if task not in task_ids or not event.get('bootUUID') or event.get('machTimestamp') is None:
            continue
        try:
            when = int(datetime.datetime.fromisoformat(event['timestamp']).timestamp() * 1000)
        except (KeyError, ValueError):
            continue
        key = hashlib.sha256((event['bootUUID'] + ':' + task + ':' + str(event['machTimestamp'])).encode()).hexdigest()[:32]
        rows.append(receipt(task, host, 'launchd-event:' + key, 'unknown', finished=when,
                            summary='System journal: service became inactive. This is a lifecycle event, not proof of a successful execution; no exit code was recorded in this event.', evidence='state-change'))
    return rows


def read_receipts(directory, task_ids, host):
    rows = []
    for path in sorted(Path(directory).glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)[:4000]:
        try:
            row = json.loads(path.read_text())
            if not isinstance(row, dict):
                continue
            pid = row.pop('wrapperPid', None)
            if row.get('status') == 'running' and isinstance(pid, int):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    row['status'] = 'unknown'
                    row['summary'] = 'Invocation started, but its recorder is no longer running and no completion receipt was written.'
                except PermissionError:
                    pass
            if row.get('taskId') in task_ids and row.get('host') == host:
                rows.append(row)
        except (OSError, ValueError):
            continue
    return rows
