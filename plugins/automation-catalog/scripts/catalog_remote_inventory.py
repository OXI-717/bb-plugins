"""Bounded official BB-terminal transport for read-only inventory code."""
import base64
import json
from pathlib import Path
import shlex
import subprocess
import time


def remote(host, bb='bb'):
    def cli(args):
        r=subprocess.run([bb,*args],capture_output=True,text=True,timeout=15)
        if r.returncode or len(r.stdout)>1_000_000:
            raise RuntimeError('Remote inventory unavailable')
        p=json.loads(r.stdout)
        if p.get('ok') is False:
            raise RuntimeError('Remote inventory refused')
        return p
    source=Path(__file__).with_name('catalog_inventory.py').read_text()
    code=source.rsplit("if __name__ == '__main__':",1)[0]+'\nimport time\nprint(json.dumps(dict(discover(),observedAt=int(time.time()*1000))))\n'
    terminal=cli(['terminal','create','--machine',host,'--cwd','/','--title','Read-only inventory',
                  '--command','python3 -c '+shlex.quote(code),'--json'])
    identifier=terminal['id']
    try:
        if terminal.get('hostId')!=host:
            raise RuntimeError('Remote host mismatch')
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            output=cli(['terminal','output',identifier,'--tail-bytes','200000','--json'])
            if output.get('status')=='exited':
                if output.get('exitCode')!=0 or output.get('truncated'):
                    raise RuntimeError('Incomplete remote inventory')
                text=''.join(base64.b64decode(c['dataBase64']).decode() for c in output.get('chunks',[]) if 'dataBase64' in c)
                return json.loads(text)
            time.sleep(2)
        raise RuntimeError('Remote inventory timeout')
    finally:
        # Only this short-lived, read-only terminal belongs to the audit.
        cli(['terminal','close',identifier,'--json'])
