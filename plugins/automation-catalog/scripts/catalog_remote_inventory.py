"""Bounded official BB-terminal transport for read-only inventory code."""
import base64
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import time
import zlib


MAX_COMMAND_BYTES = 10000
MAX_SOURCE_BYTES = 65536


def validate_command(command):
    # BB checks characters; a byte bound also protects non-ASCII CLI transports.
    if len(command) > MAX_COMMAND_BYTES or len(command.encode('utf-8')) > MAX_COMMAND_BYTES:
        raise ValueError('Remote inventory payload exceeds terminal command limit')
    return command


def inventory_command(source):
    if not isinstance(source, bytes) or not 0 < len(source) <= MAX_SOURCE_BYTES:
        raise ValueError('Remote inventory source exceeds payload bound')
    encoded = base64.b64encode(zlib.compress(source, 9)).decode('ascii')
    digest = hashlib.sha256(source).hexdigest()
    # Only stdlib is required remotely. Verify the exact source bytes before
    # compile/exec; do not strip the entrypoint or maintain a second Mac body.
    code = f'''import base64,hashlib,zlib
d=zlib.decompressobj()
s=d.decompress(base64.b64decode({encoded!r},validate=True),{MAX_SOURCE_BYTES + 1})
if len(s)>{MAX_SOURCE_BYTES} or not d.eof or d.unused_data or d.unconsumed_tail or hashlib.sha256(s).hexdigest()!={digest!r}:
 raise ValueError('Inventory payload integrity failed')
exec(compile(s,'<catalog_inventory.py>','exec'),{{'__name__':'__main__'}})
'''
    return validate_command('python3 -I -c ' + shlex.quote(code))


def remote(host, bb='bb'):
    def cli(args):
        r=subprocess.run([bb,*args],capture_output=True,text=True,timeout=15)
        if r.returncode or len(r.stdout)>1_000_000:
            raise RuntimeError('Remote inventory unavailable')
        p=json.loads(r.stdout)
        if p.get('ok') is False:
            raise RuntimeError('Remote inventory refused')
        return p
    command=inventory_command(Path(__file__).with_name('catalog_inventory.py').read_bytes())
    terminal=cli(['terminal','create','--machine',host,'--cwd','/','--title','Read-only inventory',
                  '--command',command,'--json'])
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
