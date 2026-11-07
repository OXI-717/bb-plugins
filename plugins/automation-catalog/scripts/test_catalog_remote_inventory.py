import json
import subprocess
import unittest
from unittest.mock import patch
from catalog_remote_inventory import remote

class TransportTests(unittest.TestCase):
    def test_mismatched_host_terminal_is_closed(self):
        calls=[]
        def run(argv,**kwargs):
            calls.append(argv)
            payload={'id':'terminal-sample','hostId':'wrong'} if 'create' in argv else {'ok':True}
            return subprocess.CompletedProcess(argv,0,json.dumps(payload),'')
        with patch('catalog_remote_inventory.subprocess.run',side_effect=run):
            with self.assertRaises(RuntimeError):remote('sample')
        self.assertTrue(any('close' in argv and 'terminal-sample' in argv for argv in calls))
