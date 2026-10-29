import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('doctor',Path(__file__).with_name('claude-host-doctor.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class DoctorTests(unittest.TestCase):
    def local(self,text='No installation issues',exit=0):
        def run(args,**kw):
            self.assertEqual(kw['stdin'],subprocess.DEVNULL)
            self.assertEqual(kw['env']['DISABLE_AUTOUPDATER'],'1')
            self.assertNotIn('--force',args)
            if args[-1]=='--version':return subprocess.CompletedProcess(args,0,stdout='2.1.312 (Claude Code)\n')
            self.assertEqual(args[-1],'doctor');kw['stdout'].write(text)
            return subprocess.CompletedProcess(args,exit)
        with tempfile.TemporaryDirectory() as d:
            home=Path(d);exe=home/'.local/bin/claude';exe.parent.mkdir(parents=True);exe.touch()
            with patch.object(m.Path,'home',return_value=home):return m.local_report(run)
    def test_clean_requires_positive_doctor_evidence(self):
        self.assertEqual(self.local(),{'status':'clean','version':'2.1.312','doctorExit':0,'issues':[]})
    def test_warning_exit_zero_is_not_clean_and_raw_private_text_is_not_retained(self):
        r=self.local('Multiple installations found\nprivate-fixture-value')
        self.assertEqual(r['status'],'attention');self.assertIn('duplicate-installation',r['issues']);self.assertNotIn('private-fixture-value',json.dumps(r))
    def test_unknown_output_and_large_output_fail_closed(self):
        self.assertNotEqual(self.local('unknown shape')['status'],'clean')
        self.assertIn('diagnostic-truncated',self.local('No installation issues'+'x'*66000)['issues'])
    def test_failed_doctor_does_not_appear_clean(self):
        self.assertIn('doctor-not-clean',self.local(exit=1)['issues'])
    def test_offline_does_not_create_terminal(self):
        with patch.object(m,'bb',side_effect=AssertionError('no BB call')):
            self.assertEqual(m.check_host('host_fixture',False)['status'],'offline')
    def test_strict_output_rejects_raw_fields_and_forged_clean(self):
        good={'status':'clean','version':'2.1.312','doctorExit':0,'issues':[]}
        for bad in [{**good,'raw':'private-fixture'}, {**good,'doctorExit':True}, {**good,'issues':['private-fixture']}, {**good,'version':None}, {**good,'status':'healthy'}]:
            with self.assertRaises(ValueError):m.validate_report(bad)
    def test_terminal_target_is_authenticated_native_identity(self):
        with patch.object(m,'bb',return_value={'id':'terminal-fixture','hostId':'host_foreign'}):
            with self.assertRaises(ValueError):m.check_host('host_fixture',True)
    def test_same_local_payload_is_bound_to_requested_host_and_owned_terminal_closed(self):
        report={'status':'clean','version':'2.1.312','doctorExit':0,'issues':[]};calls=[]
        def bb(*args,**kw):
            calls.append(args)
            if args[1]=='create':return {'id':'terminal-fixture','hostId':'host_fixture'}
            if args[1]=='wait':return {'exitCode':0}
            if args[1]=='output':return {'status':'exited','exitCode':0,'chunks':[{'dataBase64':base64.b64encode(json.dumps(report).encode()).decode()}]}
            if args[1]=='close':return {}
            raise AssertionError(args)
        with patch.object(m,'bb',side_effect=bb):r=m.check_host('host_fixture',True)
        self.assertEqual(r['status'],'clean');self.assertEqual(calls[-1],('terminal','close','terminal-fixture'))
    def test_json_flag_precedes_remote_command_separator(self):
        with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,stdout='{}')) as run:
            m.bb('terminal','create','--machine','host_fixture','--','python3','-c','fixed')
        args=run.call_args.args[0];self.assertLess(args.index('--json'),args.index('--'))
    def test_timeout_returns_no_exception_text(self):
        with tempfile.TemporaryDirectory() as d:
            home=Path(d);exe=home/'.local/bin/claude';exe.parent.mkdir(parents=True);exe.touch()
            with patch.object(m.Path,'home',return_value=home):
                r=m.local_report(lambda *a,**kw:(_ for _ in ()).throw(subprocess.TimeoutExpired('private-fixture',1)))
        self.assertIn('diagnostic-timeout',r['issues']);self.assertNotIn('private-fixture',json.dumps(r))
if __name__=='__main__':unittest.main()
