"""Bounded metadata-only scheduler discovery. Never executes or changes a job."""
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
    result = subprocess.run(argv, capture_output=True, text=True, timeout=25)
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


def discover(run=command, system=None, home=None, etc=None):
    """Return identities only; command arguments and environment never leave host."""
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
        for scope in ('system', 'user'):
            prefix = ['systemctl'] + (['--user'] if scope == 'user' else [])
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
                return names
            probe('systemd', scope, read)
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
