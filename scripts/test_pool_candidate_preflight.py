import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pool_candidate_preflight import preflight

class CandidateTests(unittest.TestCase):
    def test_commands_pass_but_live_readiness_remains_unknown(self):
        root=Path(__file__).resolve().parent.parent
        artifact='plugins/account-pool-balanced/src/maintenance.ts'
        with tempfile.TemporaryDirectory() as temp:
            manifest=Path(temp)/'manifest.json';output=Path(temp)/'receipt.json'
            manifest.write_text(json.dumps({'artifacts':{artifact:hashlib.sha256((root/artifact).read_bytes()).hexdigest()},'tests':['src/maintenance.test.ts']}))
            calls=[]
            def run(command, **kwargs):
                calls.append(command)
                return subprocess.CompletedProcess(command,0,'ok','')
            result=preflight(manifest,output,runner=run)
            self.assertTrue(result['candidateChecksPassed'])
            self.assertEqual(result['status'],'unknown')
            self.assertEqual(len(calls),4)
            self.assertTrue(all(s['checkedAt'].endswith('+00:00') for s in result['stages']))
            self.assertEqual(next(s for s in result['stages'] if s['name']=='live-provider')['status'],'unknown')

    def test_wrong_hash_blocks_execution_and_traversal_is_rejected(self):
        for artifact in ['plugins/account-pool-balanced/src/maintenance.ts','../outside']:
            with self.subTest(artifact=artifact), tempfile.TemporaryDirectory() as temp:
                manifest=Path(temp)/'manifest.json';output=Path(temp)/'receipt.json'
                manifest.write_text(json.dumps({'artifacts':{artifact:'0'*64},'tests':['src/maintenance.test.ts']}))
                with patch('pool_candidate_preflight.subprocess.run') as run:
                    result=preflight(manifest,output,runner=run)
                self.assertFalse(result['candidateChecksPassed'])
                self.assertEqual(result['status'],'blocked')
                run.assert_not_called()

    def test_failed_build_is_not_candidate_pass(self):
        root=Path(__file__).resolve().parent.parent
        artifact='plugins/account-pool-balanced/src/maintenance.ts'
        with tempfile.TemporaryDirectory() as temp:
            manifest=Path(temp)/'manifest.json';output=Path(temp)/'receipt.json'
            manifest.write_text(json.dumps({'artifacts':{artifact:hashlib.sha256((root/artifact).read_bytes()).hexdigest()},'tests':['src/maintenance.test.ts']}))
            result=preflight(manifest,output,runner=lambda *a,**k:subprocess.CompletedProcess(a,1,'','failed'))
            self.assertFalse(result['candidateChecksPassed'])
            self.assertEqual(result['status'],'blocked')
