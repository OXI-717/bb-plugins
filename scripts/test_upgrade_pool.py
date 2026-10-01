import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import upgrade_pool as u


class UpgradeTests(unittest.TestCase):
    def test_bash_entrypoint_empty_and_explicit_arguments(self):
        script = Path(__file__).with_name('upgrade-pool.sh')
        for flags in (['--help'], ['--version', 'bad'], ['--unknown']):
            result = subprocess.run(['/bin/bash', str(script), *flags], capture_output=True, text=True)
            self.assertNotIn('unbound variable', result.stderr)
            self.assertEqual(result.returncode, 0 if flags == ['--help'] else (1 if flags[0] == '--version' else 2))

    def test_empty_arguments_are_forwarded_without_empty_array_expansion(self):
        with tempfile.TemporaryDirectory() as temp:
            stub = Path(temp) / 'python3'
            stub.write_text('#!/bin/sh\nprintf "%s\\n" "$@"\n')
            stub.chmod(0o700)
            env = {**os.environ, 'PATH': temp + os.pathsep + os.environ['PATH']}
            script = Path(__file__).with_name('upgrade-pool.sh').resolve()
            result = subprocess.run(['/bin/bash', str(script)], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(result.stdout.splitlines(), [str(script.with_name('upgrade_pool.py'))])

    def test_sandbox_runs_whole_workflow(self):
        from upgrade_pool_sandbox import sandbox
        with contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(sandbox(u), 0)
        self.assertIn('SANDBOX PASS', output.getvalue())

    def test_sandbox_blocks_direct_subprocess_escape(self):
        from upgrade_pool_sandbox import sandbox
        def unsafe(*args):
            return u.subprocess.run(['bb', 'plugin', 'update', u.PLUGIN, '--yes'])
        with patch.object(u, 'perform', side_effect=unsafe), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(sandbox(u), 1)
        self.assertIn('forbids real subprocesses', output.getvalue())

    def test_no_terminal_never_approves_interruption(self):
        with patch('builtins.open', side_effect=OSError('no tty')):
            self.assertFalse(u.confirm_interrupt())

    def test_lock_refuses_second_upgrader(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            data = root / 'plugins' / u.PLUGIN
            data.mkdir(parents=True)
            (data/'data.db').touch()
            (root/'backups').mkdir()
            with (root/'backups'/(u.PLUGIN+'-upgrade.lock')).open('a') as lock:
                u.fcntl.flock(lock, u.fcntl.LOCK_EX | u.fcntl.LOCK_NB)
                with patch.object(u.sys,'argv',['upgrade']), patch.object(u,'bb',return_value={'dataDir':temp}), patch.dict(os.environ,{'BB_SERVER_URL':'http://127.0.0.1'}), patch.object(u,'perform') as perform, contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(u.main(),1)
                    perform.assert_not_called()

    def test_semver_and_annotated_tags(self):
        rows = '\n'.join(f'{sha * 40} refs/tags/{u.PREFIX}v{tag}' for sha, tag in [('a','0.4.9'),('b','0.4.10'),('c','0.4.10^{}'),('d','0.5.0')])
        self.assertEqual(u.parse_tags(rows, '^0.4.1'), ('0.4.10', 'c' * 40))
        self.assertFalse(u.compatible('0.0.2', '^0.0.1'))
        self.assertTrue(u.compatible('1.9.0', '^1.2.3'))
        self.assertFalse(u.compatible('1.3.0', '~1.2.3'))
        with self.assertRaises(u.UpgradeError):
            u.parse_tags(rows, 'latest')

    def test_release_must_be_immutable_and_expected_version_must_match(self):
        rows = 'a' * 40 + ' refs/tags/' + u.PREFIX + 'v0.4.7'
        release = {'tag_name':u.PREFIX+'v0.4.7', 'immutable':True, 'draft':False, 'prerelease':False}
        with patch.object(u, 'run', return_value=rows), patch.object(u.urllib.request, 'urlopen') as urlopen:
            urlopen.return_value.__enter__.return_value = io.StringIO(json.dumps(release))
            self.assertEqual(u.release_target({'range':'^0.4.1'}, '0.4.7'), ('0.4.7','a'*40))
            with self.assertRaises(u.UpgradeError):
                u.release_target({'range':'^0.4.1'}, '0.4.6')
            release['immutable'] = False
            urlopen.return_value.__enter__.return_value = io.StringIO(json.dumps(release))
            with self.assertRaises(u.UpgradeError):
                u.release_target({'range':'^0.4.1'})

    def test_source_rejects_similar_or_foreign_repository(self):
        source = {'range':'^0.4.1', 'tagPrefix':u.PREFIX, 'subdirectory':'plugins/'+u.PLUGIN,
                  'requested':'git:'+u.REPO+'@semver:'+u.PREFIX+':^0.4.1'}
        with patch.object(u, 'bb', return_value=source):
            self.assertEqual(u.source_info(), source)
            source['requested'] += '-other'
            with self.assertRaises(u.UpgradeError):
                u.source_info()

    def test_idle_with_real_host_contract_without_mocking_reporter(self):
        pool = {'inFlight': 0, 'hosts': [{'hostId': 'host-test', 'hostName': 'Test machine', 'mintedAt': 1, 'lastUsedAt': 2}], 'accounts': []}
        def command(*args):
            if args == ('pool', 'status'): return pool
            if args == ('thread', 'list', '--include-hidden'): return []
            raise AssertionError(args)
        output = []
        with patch.object(u, 'bb', side_effect=command), patch.object(u.time, 'sleep'):
            self.assertFalse(u.wait_idle(output.append))
        self.assertIn('Pool idle: three checks passed.', output)

    def test_busy_report_uses_host_name_from_contract(self):
        output = []
        pool = {'inFlight': 1, 'hosts': [{'hostId':'host-test', 'hostName':'Test machine'}],
                'accounts':[{'id':'account-test','provider':'codex','inFlight':1,'lastUsedHostId':'host-test'}]}
        with patch.object(u, 'bb', return_value=[]): u.report_pool(pool, output.append)
        self.assertTrue(any('Test machine' in line for line in output))

    def test_check_reports_live_status_even_when_already_current(self):
        source = {'history':[{'version':'b'*40}]}
        args = argparse.Namespace(check=True, version=None, interrupt_now=False)
        def command(*args):
            if args == ('pool','status'):
                return {'inFlight':0, 'hosts':[{'hostId':'host-test','hostName':'Test machine'}], 'accounts':[]}
            if args == ('thread','list','--include-hidden'): return []
            raise AssertionError(args)
        output = []
        with patch.object(u,'installed',return_value={'version':'1.0.1'}), patch.object(u,'source_info',return_value=source), patch.object(u,'release_target',return_value=('1.0.1','b'*40)), patch.object(u,'bb',side_effect=command) as api, patch.object(u,'wait_idle') as idle, patch.object(u,'backup_state') as backup, patch.object(u,'run') as update:
            self.assertEqual(u.perform(args, Path('/unused'), Path('/unused'), output.append), 'ALREADY_CURRENT')
            api.assert_any_call('pool','status')
            idle.assert_not_called(); backup.assert_not_called(); update.assert_not_called()
        self.assertIn('In-flight requests: 0', output)

    def test_idle_requires_three_consecutive_zero_counts(self):
        with patch.object(u, 'bb', side_effect=[{'inFlight': n} for n in [0,1,0,0,0]]), patch.object(u, 'report_pool'), patch.object(u.time,'sleep'), patch.object(u,'confirm_interrupt') as confirm:
            self.assertFalse(u.wait_idle(lambda _: None))
            confirm.assert_not_called()

    def test_interruption_requires_explicit_answer_and_timeout_cancels(self):
        with patch.object(u, 'bb', return_value={'inFlight':1}), patch.object(u,'report_pool'), patch.object(u,'confirm_interrupt',return_value=True):
            self.assertTrue(u.wait_idle(lambda _: None, prompt_now=True))
        with patch.object(u, 'bb', return_value={'inFlight':1}), patch.object(u,'report_pool'), patch.object(u,'confirm_interrupt',return_value=False) as confirm, patch.object(u.time,'sleep'), patch.object(u.time,'monotonic', side_effect=[0,0,301,901]):
            with self.assertRaises(u.UpgradeError):
                u.wait_idle(lambda _: None)
            confirm.assert_called_once()

    def test_online_backup_includes_uncheckpointed_wal_and_private_files(self):
        with tempfile.TemporaryDirectory() as temp:
            data = Path(temp)/'plugin'; data.mkdir()
            database = sqlite3.connect(data/'data.db')
            self.addCleanup(database.close)
            database.execute('PRAGMA journal_mode=WAL')
            database.execute('CREATE TABLE sample (value INTEGER)')
            database.execute('INSERT INTO sample VALUES (42)'); database.commit()
            (data/'secrets').mkdir(); (data/'secrets'/'synthetic.txt').write_text('test fixture')
            target = Path(temp)/'backup'
            u.backup_state(data,target,{'accounts':[], 'routing':{},'enabledAccountCount':0},{},{},{})
            with contextlib.closing(sqlite3.connect(target/'data.db')) as copied:
                self.assertEqual(copied.execute('SELECT value FROM sample').fetchone()[0],42)
            self.assertEqual((target/'secrets'/'synthetic.txt').stat().st_mode & 0o777,0o600)

    def workflow(self, *, check=False, changed=False, fail=False, wrong_sha=False, wrong_accounts=False, wrong_drain=False):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        data = Path(temp.name); db=sqlite3.connect(data/'data.db'); db.close()
        state = {'accepting':True,'inFlight':0,'accounts':[{'id':'synthetic','enabled':True,'policy':{'enabled':False}, 'drainOnce':True, 'drainGeneration':'synthetic-generation'}], 'routing':{'codex':True},'enabledAccountCount':1}
        source = {'history':[{'version':'b'*40}], 'range':'^0.4.1'}
        updated_source = {**source,'history':[{'version':('c' if wrong_sha else 'a')*40}]}
        infos = [{'version':'0.4.6'}, {'version':'0.4.7'}]
        sources = [source, source, updated_source]
        targets = [('0.4.7','a'*40), ('0.4.8','c'*40) if changed else ('0.4.7','a'*40)]
        status_reads = 0
        def command(*args):
            nonlocal status_reads
            if args[:2] == ('pool','status'):
                status_reads += 1
                if wrong_drain and status_reads == 3:
                    return {**state, 'accounts': [{**state['accounts'][0], 'drainOnce': False, 'drainGeneration': None}]}
                return {**state, 'accounts': []} if wrong_accounts and status_reads == 3 else state
            if args[:2] == ('plugin','config'): return {'values':{'threshold':.98}}
            if args[:2] == ('thread','list'): return []
            raise AssertionError(args)
        args=argparse.Namespace(check=check, version=None, interrupt_now=False)
        with patch.object(u,'installed',side_effect=infos), patch.object(u,'source_info',side_effect=sources), patch.object(u,'release_target',side_effect=targets), patch.object(u,'wait_idle',return_value=False) as idle, patch.object(u,'bb',side_effect=command), patch.object(u,'run',side_effect=u.UpgradeError('simulated update failure') if fail else None) as run:
            if changed or fail or wrong_sha or wrong_accounts or wrong_drain:
                with self.assertRaises(u.UpgradeError): u.perform(args,data,data,lambda _:None)
            else:
                self.assertEqual(u.perform(args,data,data,lambda _:None),'PREFLIGHT_PASS' if check else 'PASS')
            if check:
                idle.assert_not_called(); run.assert_not_called(); self.assertFalse((data/'backup').exists())
            elif changed:
                run.assert_not_called(); self.assertTrue((data/'backup'/'data.db').exists())
            else:
                run.assert_called_once_with('bb','plugin','update',u.PLUGIN,'--yes',timeout=600)
                self.assertTrue((data/'backup'/'RECOVERY.txt').exists())

    def test_post_update_drain_state_loss_fails(self): self.workflow(wrong_drain=True)
    def test_post_update_sha_mismatch_fails(self): self.workflow(wrong_sha=True)
    def test_post_update_missing_account_fails(self): self.workflow(wrong_accounts=True)
    def test_check_never_updates(self): self.workflow(check=True)
    def test_successful_upgrade(self): self.workflow()
    def test_release_race_fails_before_update(self): self.workflow(changed=True)
    def test_update_failure_keeps_backup_without_destructive_rollback(self): self.workflow(fail=True)


if __name__ == '__main__':
    unittest.main()
