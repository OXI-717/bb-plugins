#!/usr/bin/env python3
"""Read-only scheduled Claude installation checks through existing BB machine terminals.
No model, login, update, settings mutation, credential reads or implicit host discovery.
"""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def local_report(run=subprocess.run):
    import shutil
    # A fixed diagnostic, never a command supplied by the remote response or model.
    executable = Path.home() / '.local/bin/claude'
    if not executable.is_file():
        found = shutil.which('claude')
        if not found:
            return {'status': 'missing', 'version': None, 'doctorExit': None, 'issues': ['not-installed']}
        executable = Path(found)
    env = {**os.environ, 'DISABLE_AUTOUPDATER': '1', 'NO_COLOR': '1'}
    report = {'status': 'attention', 'version': None, 'doctorExit': None, 'issues': []}
    try:
        version = run([str(executable), '--version'], stdin=subprocess.DEVNULL,
                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=15, env=env)
        match = re.fullmatch(r'(\d{1,5}\.\d{1,5}\.\d{1,5}) \(Claude Code\)\s*', version.stdout)
        if version.returncode or not match:
            report['issues'].append('version-unavailable')
        else:
            report['version'] = match.group(1)
        # Raw diagnostic text is private temporary output, never copied into a receipt.
        with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as output:
            doctor = run([str(executable), 'doctor'], stdin=subprocess.DEVNULL,
                         stdout=output, stderr=subprocess.STDOUT, text=True, timeout=40, env=env)
            output.seek(0)
            text = output.read(65_537)
        report['doctorExit'] = doctor.returncode
        if len(text) > 65_536:
            report['issues'].append('diagnostic-truncated')
        else:
            text = re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', text)
            if re.search('multiple installations', text, re.I):
                report['issues'].append('duplicate-installation')
            if re.search(r'(invalid settings|settings.*validation.*error)', text, re.I):
                report['issues'].append('invalid-settings')
            if doctor.returncode or 'No installation issues' not in text:
                report['issues'].append('doctor-not-clean')
        if not report['issues']:
            report['status'] = 'clean'
    except subprocess.TimeoutExpired:
        report['issues'].append('diagnostic-timeout')
    except OSError:
        report['issues'].append('diagnostic-unavailable')
    return report


def bb(*args, timeout=30):
    values = list(args)
    values.insert(values.index('--') if '--' in values else len(values), '--json')
    proc = subprocess.run([os.environ.get('BB_CLI') or 'bb', *values],
                          stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    if proc.returncode:
        raise RuntimeError('BB command unavailable')
    return json.loads(proc.stdout)


def validate_report(value):
    if not isinstance(value, dict) or set(value) != {'status', 'version', 'doctorExit', 'issues'}:
        raise ValueError('Unexpected diagnostic shape')
    if value['status'] not in ('clean', 'attention', 'missing'):
        raise ValueError('Unexpected diagnostic status')
    if value['version'] is not None and (not isinstance(value['version'], str) or not re.fullmatch(r'\d{1,5}\.\d{1,5}\.\d{1,5}', value['version'])):
        raise ValueError('Unexpected version')
    if value['doctorExit'] is not None and (type(value['doctorExit']) is not int or not -255 <= value['doctorExit'] <= 255):
        raise ValueError('Unexpected exit status')
    allowed = {'not-installed', 'version-unavailable', 'diagnostic-truncated', 'duplicate-installation', 'invalid-settings', 'doctor-not-clean', 'diagnostic-timeout', 'diagnostic-unavailable'}
    if not isinstance(value['issues'], list) or len(value['issues']) > 8 or any(type(x) is not str or x not in allowed for x in value['issues']):
        raise ValueError('Unexpected diagnostic issue')
    if value['status'] == 'clean' and (value['issues'] or value['doctorExit'] != 0 or value['version'] is None):
        raise ValueError('Unproven clean diagnostic')
    return value


def check_host(host_id, connected):
    if not connected:
        return {'status': 'offline', 'version': None, 'doctorExit': None, 'issues': []}
    # Host identity comes from the authenticated native BB target, never from this JSON payload.
    terminal = bb('terminal', 'create', '--machine', host_id, '--cwd', '/tmp',
                  '--title', 'Claude read-only installation doctor', '--', 'python3', '-c',
                  Path(__file__).read_text(), '--local')
    if terminal.get('hostId') != host_id or not isinstance(terminal.get('id'), str):
        raise ValueError('Native terminal identity mismatch')
    terminal_id = terminal['id']
    try:
        done = bb('terminal', 'wait', terminal_id, '--exit', '--timeout', '70s', timeout=75)
        if done.get('exitCode') != 0:
            raise ValueError('Diagnostic terminal did not exit successfully')
        output = bb('terminal', 'output', terminal_id, '--tail-bytes', '8192')
        if output.get('status') != 'exited' or output.get('exitCode') != 0 or output.get('truncated'):
            raise ValueError('Incomplete diagnostic output')
        chunks = output.get('chunks', [])
        if len(chunks) > 32:
            raise ValueError('Excessive diagnostic output')
        raw = b''.join(base64.b64decode(c['dataBase64'], validate=True) for c in chunks)
        if len(raw) > 8192:
            raise ValueError('Excessive diagnostic output')
        report = validate_report(json.loads(raw))
        return {**report, 'terminalId': terminal_id}
    finally:
        # Only this owned diagnostic terminal; no provider processes or sessions.
        bb('terminal', 'close', terminal_id)


def save(path, value):
    fd, name = tempfile.mkstemp(prefix='doctor-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--local', action='store_true')
    parser.add_argument('--hosts-file', type=Path)
    parser.add_argument('--state-dir', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    if args.local:
        print(json.dumps(local_report()))
        return 0
    if not args.hosts_file or not args.state_dir:
        parser.error('Explicit trusted host list and private state directory required')
    hosts = json.loads(args.hosts_file.read_text())
    if not isinstance(hosts, list) or not 1 <= len(hosts) <= 8 or any(type(h) is not str or not re.fullmatch(r'host_[a-z0-9]+', h) for h in hosts) or len(set(hosts)) != len(hosts):
        parser.error('Expected 1..8 unique existing native machine IDs')
    machines = bb('machine', 'list')
    rows = machines if isinstance(machines, list) else machines.get('machines', [])
    by_id = {m['id']: m for m in rows}
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    changed = []
    for host in hosts:
        path = args.state_dir / (host + '.json')
        try:
            previous = json.loads(path.read_text()) if path.exists() else {}
        except (OSError, ValueError):
            previous = {}
        try:
            if host not in by_id:
                report = {'status': 'unknown-host', 'version': None, 'doctorExit': None, 'issues': []}
            else:
                report = check_host(host, by_id[host].get('status') == 'connected')
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            report = {'status': 'unavailable', 'version': None, 'doctorExit': None, 'issues': []}
        report.update(hostId=host, checkedAt=int(time.time() * 1000))
        save(path, report)
        if any(report.get(k) != previous.get(k) for k in ('status', 'version', 'issues')):
            changed.append({k: report[k] for k in ('hostId', 'status', 'version', 'issues')})
    if changed:
        print(json.dumps({'claudeInstallationChanges': changed}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
