import base64
import hashlib
import json
import os
import tempfile
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import catalog_remote_inventory as transport


class PayloadTests(unittest.TestCase):
    def test_real_inventory_command_fits_bb_boundary(self):
        source=Path(transport.__file__).with_name('catalog_inventory.py').read_bytes()
        command=transport.inventory_command(source)
        self.assertLessEqual(len(command),10000)
        self.assertLessEqual(len(command.encode('utf-8')),10000)
        self.assertIn(hashlib.sha256(source).hexdigest(),command)

    def test_exact_character_and_byte_boundary(self):
        transport.validate_command('x'*10000)
        for command in ('x'*10001,'я'*5001):
            with self.assertRaisesRegex(ValueError,'payload'):
                transport.validate_command(command)

    def test_exact_source_bytes_execute_with_standard_python(self):
        source="import json\nassert __name__ == '__main__'\nprint(json.dumps({'unit':'пример.service','metadata':{'Transient':'yes','Restart':'no'}}))\n".encode()
        command=transport.inventory_command(source)
        result=subprocess.run(command,shell=True,capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['metadata'],{'Transient':'yes','Restart':'no'})
        self.assertEqual(json.loads(result.stdout)['unit'],'пример.service')

    @unittest.skipUnless(sys.platform == 'linux', 'Synthetic Linux systemd transport fixture')
    def test_full_inventory_preserves_linux_metadata(self):
        source=Path(transport.__file__).with_name('catalog_inventory.py').read_bytes()
        properties={'Id':'sample.service','LoadState':'loaded','Transient':'yes','Restart':'no',
                    'TriggeredBy':'','InvocationID':'a'*32,'ActiveState':'failed','Result':'exit-code',
                    'ExecMainCode':'1','ExecMainStatus':'70',
                    'ExecMainStartTimestamp':'Thu 2026-01-01 00:00:00 UTC',
                    'ExecMainExitTimestamp':'Thu 2026-01-01 00:00:01 UTC'}
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)
            scripts={
                'systemctl': 'import sys\nprint('+repr('\n'.join(k+'='+v for k,v in properties.items()))+" if 'show' in sys.argv else 'sample.service loaded failed failed')\n",
                'crontab': "import sys\nprint('no crontab for fixture',file=sys.stderr)\nsys.exit(1)\n",
                'sudo': 'import os,sys\nos.execvp(sys.argv[2],sys.argv[2:])\n'}
            for name,body in scripts.items():
                target=folder/name;target.write_text('#!'+sys.executable+'\n'+body);target.chmod(0o700)
            result=subprocess.run(transport.inventory_command(source),shell=True,capture_output=True,text=True,timeout=5,
                                  env={'PATH':root+os.pathsep+str(Path(sys.executable).parent)+os.pathsep+'/usr/bin:/bin'})
        self.assertEqual(result.returncode,0,result.stderr)
        rows=[r for r in json.loads(result.stdout)['observations'] if r['scheduler']=='systemd']
        self.assertEqual(len(rows),2)
        self.assertTrue(all(r['systemd']==properties for r in rows))

    def test_tampered_digest_never_executes_source(self):
        source=b'print("unexpected execution")\n'
        command=transport.inventory_command(source).replace(hashlib.sha256(source).hexdigest(),'0'*64)
        result=subprocess.run(command,shell=True,capture_output=True,text=True,timeout=5)
        self.assertNotEqual(result.returncode,0)
        self.assertNotIn('unexpected execution',result.stdout)

    def test_over_limit_and_source_bound_fail_before_terminal_create(self):
        for source in (b'x'*(transport.MAX_SOURCE_BYTES+1),b'import json\nprint("small")\n'):
            with patch.object(Path,'read_bytes',return_value=source),patch.object(transport,'MAX_COMMAND_BYTES',1),patch.object(transport.subprocess,'run') as call:
                with self.assertRaises(ValueError):transport.remote('worker')
                call.assert_not_called()

    def test_one_terminal_mac_output_and_cleanup(self):
        data={'observations':[{'scheduler':'launchd','scope':'user','unit':'example.job'}],
              'coverage':[{'scheduler':'launchd','scope':'user','ok':True}],'observedAt':1000}
        calls=[]
        def run(argv,**kwargs):
            calls.append(argv)
            if 'create' in argv:
                command=argv[argv.index('--command')+1]
                self.assertLessEqual(len(command),10000)
                response={'id':'owned-terminal','hostId':'worker'}
            elif 'output' in argv:
                response={'status':'exited','exitCode':0,'chunks':[{'dataBase64':base64.b64encode(json.dumps(data).encode()).decode()}]}
            else:response={'ok':True}
            return subprocess.CompletedProcess(argv,0,json.dumps(response),'')
        with patch.object(transport.subprocess,'run',side_effect=run):
            self.assertEqual(transport.remote('worker'),data)
        self.assertEqual(sum('create' in c for c in calls),1)
        self.assertEqual(sum('close' in c for c in calls),1)


if __name__=='__main__':unittest.main()
