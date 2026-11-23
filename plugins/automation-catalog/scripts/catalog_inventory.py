"""Bounded metadata-only scheduler discovery. Never executes or changes a job."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import subprocess
import time


def command(argv):
    result = subprocess.run(argv, capture_output=True, text=True,
                            timeout=3 if argv[0] == 'systemctl' and 'show' in argv else 25,
                            env=dict(os.environ, TZ='UTC', LC_ALL='C'))
    if result.returncode:
        raise RuntimeError('inventory access unavailable')
    if len(result.stdout) > 4_000_000:
        raise RuntimeError('inventory exceeds bound')
    return result.stdout


def launchd_label(data, fallback):
    # Empty application-uninstaller placeholders do not define a runnable job.
    if not data.get('Label') and not data.get('Program') and not data.get('ProgramArguments'):
        return None
    return data.get('Label', fallback)


def launchd_services(scope, run=command):
    """Read actual loaded labels, never infer Label from a missing filename."""
    domain = 'system' if scope == 'system' else 'gui/' + str(os.getuid())
    text = run(['launchctl', 'print', domain])
    sections = re.findall(r'^\s*services = \{\n(.*?)^\s*\}', text, re.M | re.S)
    if len(sections) != 1:
        raise RuntimeError('Unrecognized launchd domain inventory')
    labels = []
    for line in sections[0].splitlines():
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 3 or not fields[0].isdigit():
            raise RuntimeError('Incomplete launchd service row')
        labels.append(fields[2])
    return labels


SYSTEMD_FIELDS = ('Id', 'LoadState', 'Transient', 'Restart', 'TriggeredBy', 'InvocationID',
                  'ActiveState', 'Result', 'ExecMainCode', 'ExecMainStatus',
                  'ExecMainStartTimestamp', 'ExecMainExitTimestamp')


def systemd_metadata(run, prefix, names, deadline):
    """Bounded allowlisted properties; never export argv, environment or journal text."""
    result = {}
    names = sorted(n for n in names if n.endswith('.service'))
    for offset in range(0, len(names), 64):
        if time.monotonic() >= deadline:
            break  # Remaining identities stay unclassified, never disappear.
        batch = names[offset:offset + 64]
        try:
            raw = run(prefix + ['show', *batch, '--no-pager', '--property=' + ','.join(SYSTEMD_FIELDS)])
            for block in raw.strip().split('\n\n'):
                values = dict(line.split('=', 1) for line in block.splitlines() if '=' in line)
                unit = values.get('Id')
                if unit in batch:
                    result[unit] = {k: v for k, v in values.items() if k in SYSTEMD_FIELDS}
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            pass  # Identity remains visible as unclassified; never infer a one-off.
    return result


def systemd_execution(row):
    """Positive classification only. Legacy/missing metadata retains registry checks."""
    data = row.get('systemd', {})
    if (row.get('scheduler') != 'systemd' or not row.get('unit', '').endswith('.service')
            or not isinstance(data, dict) or any(not isinstance(v, str) or len(v) > 1000 for v in data.values())
            or data.get('Id') != row['unit']
            or data.get('LoadState') != 'loaded' or data.get('Transient') != 'yes'
            or data.get('Restart') != 'no' or data.get('TriggeredBy') != ''
            or not re.fullmatch('[a-f0-9]{32}', data.get('InvocationID', ''))):
        return None
    def stamp(key):
        parts = data.get(key, '').split()
        try:
            if len(parts) != 4 or parts[3] != 'UTC':
                return None
            value = datetime.datetime.fromisoformat(parts[1] + 'T' + parts[2])
            return int(value.replace(tzinfo=datetime.timezone.utc).timestamp() * 1000)
        except (ValueError, IndexError):
            return None
    started, finished = stamp('ExecMainStartTimestamp'), stamp('ExecMainExitTimestamp')
    if started is None:
        return None
    if finished is not None and finished < started:
        finished = None
    status, code = 'unknown', None
    if finished is not None:
        if data.get('ExecMainCode') == '1' and re.fullmatch(r'[0-9]{1,3}', data.get('ExecMainStatus', '')) and int(data['ExecMainStatus']) <= 255:
            code = int(data['ExecMainStatus'])
            if code != 0 or data.get('ActiveState') == 'failed' or data.get('Result') not in (None, '', 'success'):
                status = 'failed'
            elif data.get('Result') == 'success' and data.get('ActiveState') == 'inactive':
                status = 'succeeded'
        elif data.get('Result') not in (None, '', 'success'):
            status = 'failed'
    elif data.get('ActiveState') == 'failed':
        status = 'failed'
    elif data.get('ActiveState') in ('active', 'activating'):
        status = 'running'
    return dict(invocation=data['InvocationID'], startedAt=started, finishedAt=finished,
                status=status, exitCode=code)


def discover(run=command, system=None, home=None, etc=None):
    """Return identities and allowlisted execution metadata, never commands or env."""
    home = Path(home or Path.home())
    etc = Path(etc or '/etc')
    system = system or platform.system()
    observations, coverage = [], []
    def probe(scheduler, scope, read):
        try:
            units = sorted(set(read()))
            if len(units) > 5000:
                raise ValueError('too many units')
            observations.extend(dict(scheduler=scheduler, scope=scope, unit=u) for u in units)
            coverage.append(dict(scheduler=scheduler, scope=scope, ok=True))
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            coverage.append(dict(scheduler=scheduler, scope=scope, ok=False))
    if system == 'Linux':
        metadata_deadline = time.monotonic() + 8
        for scope in ('system', 'user'):
            prefix = ['systemctl'] + (['--user'] if scope == 'user' else [])
            runtime_names = set()
            def read(prefix=prefix):
                names = set()
                for action in ('list-unit-files', 'list-units'):
                    for line in run(prefix + [action, '--type=service,timer', '--all', '--no-legend', '--no-pager', '--plain']).splitlines():
                        fields = line.split()
                        first = fields[0] if fields else ''
                        # Dependency references with no backing unit are not jobs.
                        # Keep malformed/error units visible and retain real transients.
                        if action == 'list-units' and len(fields) > 3 and fields[1:4] == ['not-found', 'inactive', 'dead']:
                            continue
                        if first.endswith(('.service', '.timer')):
                            names.add(first)
                            if action == 'list-units':
                                runtime_names.add(first)
                return names
            probe('systemd', scope, read)
            rows = [r for r in observations if r['scheduler'] == 'systemd' and r['scope'] == scope]
            metadata = systemd_metadata(run, prefix, runtime_names, metadata_deadline)
            for row in rows:
                if row['unit'] in metadata:
                    row['systemd'] = metadata[row['unit']]
    elif system == 'Darwin':
        for folder, scope in ((home/'Library/LaunchAgents', 'user'), (Path('/Library/LaunchAgents'), 'global-user'), (Path('/Library/LaunchDaemons'), 'system')):
            def read(folder=folder, scope=scope):
                if not folder.exists():
                    return []
                names = []
                dangling = False
                for p in folder.glob('*.plist'):
                    try:
                        data = plistlib.loads(p.read_bytes())
                    except FileNotFoundError:
                        if p.is_symlink() and not p.exists():
                            dangling = True
                            continue
                        raise
                    label = launchd_label(data, p.stem)
                    if label is not None:
                        names.append(label)
                if dangling:
                    # The former Label is unknowable. Include EVERY loaded label
                    # so a live job survives even when its original plist vanished.
                    names.extend(launchd_services(scope, run))
                return names
            probe('launchd', scope, read)
    else:
        coverage.append(dict(scheduler='host', scope='all', ok=False))
    if system == 'Linux':
        def system_cron():
            names = []
            for directory in ('cron.d', 'cron.hourly', 'cron.daily', 'cron.weekly', 'cron.monthly'):
                folder = etc / directory
                if folder.exists():
                    names.extend(directory + ':' + p.name for p in folder.iterdir() if p.is_file() and not p.name.startswith('.'))
            if (etc/'crontab').exists():
                names.append('crontab')
            return names
        probe('cron', 'system', system_cron)
    def cron(root=False):
        argv = (['sudo', '-n'] if os.geteuid() != 0 else []) + ['crontab', '-u', 'root', '-l'] if root else ['crontab', '-l']
        result = subprocess.run(argv, capture_output=True, text=True, timeout=25) if run is command else None
        if result is not None:
            if result.returncode == 1 and 'no crontab for' in result.stderr.lower():
                return []
            if result.returncode:
                raise RuntimeError('cron unavailable')
            content = result.stdout
        else:
            content = run(argv)
        ids = set()
        timezone = 'host timezone'
        for raw in content.splitlines():
            line=raw.strip()
            if line.startswith('CRON_TZ='):
                timezone=line.split('=',1)[1].strip().strip('"\'')
            if not line or line.startswith('#') or re.match(r'^\w+\s*=', line):
                continue
            parts=line.split(None,1 if line.startswith('@') else 5)
            if len(parts) not in (2,6):
                continue
            digest=hashlib.sha256((timezone+'\n'+line).encode()).hexdigest()[:24]
            marker=re.search(r'# bb-catalog-task=(cron:[a-f0-9]{24});name=([A-Za-z0-9_.-]+)$',line)
            ids.add(marker[1] if marker and 'catalog_receipt_run.py' in line else 'cron:'+digest)
        return sorted(ids)
    probe('cron', 'user', cron)
    probe('cron', 'root', lambda: cron(root=True))
    return dict(observations=observations, coverage=coverage)


if __name__ == '__main__':
    print(json.dumps(dict(discover(), observedAt=int(time.time()*1000))))
