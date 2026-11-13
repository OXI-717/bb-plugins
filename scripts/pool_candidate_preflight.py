"""Repeatable candidate checks; evidence from providers remains a separate stage."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import socket
import ssl
import subprocess
import time
import urllib.parse


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def preflight(manifest_path, output, *, runner=subprocess.run):
    root = Path(__file__).resolve().parent.parent
    manifest = json.loads(Path(manifest_path).read_text())
    stages = []
    def stage(name, status, detail):
        stages.append(dict(name=name, status=status, checkedAt=utc(), detail=detail))
    files = manifest.get('artifacts', {})
    valid = bool(files)
    for name, expected in files.items():
        p = (root / name).resolve()
        if not p.is_relative_to(root) or not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
            valid = False
    stage('candidate-artifacts', 'pass' if valid else 'blocked', 'SHA256 manifest comparison')
    package = root / 'plugins/account-pool-balanced'
    tests = manifest.get('tests', [])
    if not tests or any(not isinstance(t, str) or not re.fullmatch(r'src/[A-Za-z0-9_./-]+\.test\.(ts|tsx)', t) or '..' in Path(t).parts or not (package / t).is_file() for t in tests):
        stage('focused-tests', 'blocked', 'Explicit existing focused test files required')
    elif valid:
        for name, command in [('typecheck', ['npm','run','typecheck']),
                              ('focused-tests', ['npx','--no-install','vitest','run',*tests]),
                              ('build', ['bb','plugin','build','.']),
                              ('migration-sandbox', ['python3',str(root/'scripts/upgrade_pool.py'),'--sandbox'])]:
            try:
                result = runner(command, cwd=package, capture_output=True, text=True, timeout=300)
                stage(name, 'pass' if result.returncode == 0 else 'blocked', 'command completed' if result.returncode == 0 else 'command failed; inspect private log')
                with Path(str(output)+'.log').open('a') as log:
                    log.write(name+'\n'+result.stdout+result.stderr+'\n')
            except (OSError, subprocess.TimeoutExpired):
                stage(name, 'unknown', 'command unavailable or timed out')
    if not manifest.get('network'):
        stage('network', 'unknown', 'No endpoints supplied; DNS/TLS not verified')
    for url in manifest.get('network', []):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
            stage('network', 'blocked', 'Only credential-free HTTPS endpoints supported')
            continue
        started = time.monotonic()
        try:
            with socket.create_connection((parsed.hostname, parsed.port or 443), timeout=10) as conn:
                with ssl.create_default_context().wrap_socket(conn, server_hostname=parsed.hostname):
                    stage('network', 'pass', f'DNS/TCP/TLS verified in {time.monotonic()-started:.2f}s; provider response not tested')
        except (OSError, ValueError):
            stage('network', 'blocked', 'DNS/TCP/TLS unavailable; no provider claim')
    # Missing external evidence cannot be upgraded to PASS by a successful build.
    for name in ['host-bundle-compatibility', 'account-policy-preservation', 'isolated-diagnostic', 'account-eligibility', 'live-provider']:
        stage(name, 'unknown', 'Requires separate fresh targeted receipt; fixtures do not establish provider readiness')
    result = dict(schemaVersion=1, checkedAt=utc(), stages=stages,
                  status='blocked' if any(s['status']=='blocked' for s in stages) else 'unknown',
                  candidateChecksPassed=valid and all(s['status']=='pass' for s in stages if s['name'] in ('typecheck','focused-tests','build','migration-sandbox')) and any(s['name']=='build' for s in stages))
    result['installReady'] = False
    result['userReady'] = False
    result['installReadyScope'] = 'Pending fresh reviewed compatibility and coordinated deployment receipt; runtimeBlocked alone need not block installation'
    Path(output).write_text(json.dumps(result, indent=2)+'\n')
    return result
