import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser(description='Publish catalog snapshots on a script timer; never invokes a model.')
    parser.add_argument('--config', type=Path, required=True)
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if config.get('enabled') is not True:
        return 0
    root = args.config.parent
    fd = os.open(root / 'sync.lock', os.O_WRONLY | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        state_path = root / 'last-cycle.json'
        state = json.loads(state_path.read_text()) if state_path.exists() else {'lastSuccess': {}}
        state.update(startedAt=time.time(), pid=os.getpid(), results=[])
        state_path.write_text(json.dumps(state))
        state_path.chmod(0o600)
        for source in config['sources']:
            identifier = source['id']
            if time.time() - state['lastSuccess'].get(identifier, 0) < source['intervalSeconds']:
                continue
            env = dict(os.environ, BB_SERVER_URL=config['serverUrl'])
            argv = [sys.executable, str(Path(__file__).with_name('catalog_collect.py')),
                    source['kind'], '--source-id', identifier, '--name', source['name'], '--publish', *source.get('options', [])]
            try:
                result = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=120)
                if result.returncode == 0:
                    state['lastSuccess'][identifier] = time.time()
                state['results'].append(dict(source=identifier, exitCode=result.returncode))
            except (OSError, subprocess.TimeoutExpired) as error:
                state['results'].append(dict(source=identifier, error=type(error).__name__))
        state['finishedAt'] = time.time()
        temporary = state_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(state))
        temporary.chmod(0o600)
        os.replace(temporary, state_path)
        print(json.dumps(state['results']))
        return 1 if any(item.get('exitCode', 1) != 0 for item in state['results']) else 0


if __name__ == '__main__':
    sys.exit(main())
