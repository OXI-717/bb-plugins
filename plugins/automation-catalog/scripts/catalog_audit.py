"""Run the configured inventory comparison as part of catalog_sync, without models."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

from catalog_compliance import evaluate, snapshot
from catalog_inventory import discover
from catalog_remote_inventory import remote


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if len(config['hosts']) > 32 or len(config.get('remoteHosts', [])) > 3:
        raise ValueError('Bounded host selection required')
    if not 60000 <= config['staleAfterMs'] <= 604800000 or config.get('reminderMs', 86400000) < 60000:
        raise ValueError('Invalid freshness or reminder bound')
    if not 1 <= config.get('maxEventsPerCycle', 20) <= 100:
        raise ValueError('Invalid event rate bound')
    now = int(time.time()*1000)
    inventories = {config['host']: dict(discover(), observedAt=now)}
    for host, path in config.get('inventoryFiles', {}).items():
        if host == config['host']:
            raise ValueError('Remote inventory must not override local discovery')
        try:
            inventories[host] = json.loads(Path(path).read_text())
        except (OSError, ValueError):
            pass  # Explicit expected host becomes coverage-unknown, never PASS.
    bb = os.environ.get('BB_CLI') or 'bb'
    for host in config.get('remoteHosts', []):
        try:
            inventories[host] = remote(host, bb)
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired):
            pass
    result = subprocess.run([bb,'plugin','rpc','call','automation-catalog','catalog_list','--json'],
                            capture_output=True,text=True,timeout=30)
    if result.returncode or len(result.stdout)>4_000_000:
        raise RuntimeError('Catalog unavailable; no recovery snapshot published')
    catalog = json.loads(result.stdout)
    sources = {s['id']:s for s in catalog['sources']}
    for task in catalog['tasks']:
        if task['scheduler'] != 'bb' or task.get('missing'):
            continue
        host = config.get('hostAliases', {}).get(task['host'], task['host'])
        if host not in config['hosts']:
            continue
        inv = inventories.setdefault(host, dict(observedAt=now, coverage=[dict(scheduler='host', scope='all', ok=False)], observations=[]))
        inv['observations'].append(dict(scheduler='bb', scope=task.get('projectId') or 'unknown', unit=task['id']))
    findings = evaluate(config,inventories,sources,now)
    state_path = args.config.with_name('audit-state.json')
    state = json.loads(state_path.read_text()) if state_path.exists() else {}
    payload, new_state = snapshot(config,findings,state,now)
    if not args.publish:
        print(json.dumps(payload))
        return 0
    with tempfile.TemporaryDirectory() as directory:
        target=Path(directory)/'snapshot.json'
        target.write_text(json.dumps(payload));target.chmod(0o600)
        published=subprocess.run([bb,'plugin','rpc','call','automation-catalog','catalog_publish','--input-file',str(target),'--json'],
                                 capture_output=True,text=True,timeout=30)
        if published.returncode:
            raise RuntimeError('Inventory snapshot publication failed')
        ack=json.loads(published.stdout)
        if ack.get('ok') is False or ack.get('isError'):
            raise RuntimeError('Inventory snapshot rejected')
    # Advance dedup state only after durable publication acknowledgement.
    temporary=state_path.with_suffix('.tmp')
    temporary.write_text(json.dumps(new_state));temporary.chmod(0o600)
    os.replace(temporary,state_path)
    print(json.dumps(dict(findings=len(findings),events=len(payload['runs']),published=True)))
    return 0


if __name__=='__main__':
    main()
