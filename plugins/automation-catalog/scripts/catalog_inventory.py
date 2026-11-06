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
                        first = line.split()[0] if line.split() else ''
                        if first.endswith(('.service', '.timer')):
                            names.add(first)
                return names
            probe('systemd', scope, read)
    elif system == 'Darwin':
        for folder, scope in ((home/'Library/LaunchAgents', 'user'), (Path('/Library/LaunchAgents'), 'global-user'), (Path('/Library/LaunchDaemons'), 'system')):
            def read(folder=folder):
                if not folder.exists():
                    return []
                names = []
                for p in folder.glob('*.plist'):
                    data = plistlib.loads(p.read_bytes())
                    names.append(data.get('Label', p.stem))
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
    def cron():
        result = subprocess.run(['crontab', '-l'], capture_output=True, text=True, timeout=25) if run is command else None
        if result is not None:
            if result.returncode == 1 and 'no crontab for' in result.stderr.lower():
                return []
            if result.returncode:
                raise RuntimeError('cron unavailable')
            content = result.stdout
        else:
            content = run(['crontab', '-l'])
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
    if os.geteuid() != 0:
        coverage.append(dict(scheduler='cron', scope='root', ok=False))
    return dict(observations=observations, coverage=coverage)


if __name__ == '__main__':
    print(json.dumps(dict(discover(), observedAt=int(time.time()*1000))))
