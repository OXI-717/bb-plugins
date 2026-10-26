import copy
import contextlib
import io
import time
from unittest.mock import patch
import upgrade_pool as upgrade
import json
from pathlib import Path
import tempfile
import unittest

from pool_session_pause import SessionPause


class FakeBB:
    def __init__(self):
        self.threads = {
            'thread-a': dict(id='thread-a', projectId='project-a', environmentId='env-a',
                             providerId='provider-a', updatedAt=1, status='active', title='PRIVATE'),
            'thread-b': dict(id='thread-b', projectId='project-b', environmentId='env-b',
                             providerId='provider-b', updatedAt=1, status='idle'),
        }
        self.calls = []
        self.lease = None
        self.fail_stop = False
        self.ambiguous_send = False

    def running(self):
        return [{"id": t["id"], "hostId": None} for t in self.threads.values()
                if t["status"] in ("active", "starting")]

    def __call__(self, *args):
        self.calls.append(args)
        if args[0] == 'pool-maintenance':
            if args[1] == 'acquire':
                self.lease = {'owner': args[3], 'expiresAt': time.time()*1000+1_800_000}
            if args[1] == 'release':
                self.lease = None
                for t in self.threads.values():
                    if t.get('queuedMessageCount', 0):
                        t.update(status='active', queuedMessageCount=0)
            return {'schemaVersion': 1, 'scope': 'all-hosts-all-projects', 'lease': self.lease}
        if args[:2] == ('thread', 'list'):
            return copy.deepcopy(list(self.threads.values()))
        thread = self.threads[args[2]]
        if args[1] == 'show':
            return {'thread': copy.deepcopy(thread)}
        if args[1] == 'stop':
            if self.fail_stop:
                raise RuntimeError('command failed')
            thread.update(status='idle', updatedAt=2)
        elif args[1] == 'tell':
            if self.lease:
                thread['queuedMessageCount'] = thread.get('queuedMessageCount', 0) + 1
            else:
                thread.update(status='active', updatedAt=3)
            if self.ambiguous_send:
                raise TimeoutError()
        else:
            raise AssertionError(args)
        return {}


class SessionPauseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'sessions.json'
        self.bb = FakeBB()
        self.pause = SessionPause(self.path, self.bb, lambda _: None, running=self.bb.running)

    def test_only_active_sessions_resume_with_sticky_provider_and_private_metadata(self):
        self.pause.stop()
        self.pause.resume()
        self.assertEqual(self.bb.threads['thread-a']['status'], 'active')
        self.assertEqual(self.bb.threads['thread-b']['status'], 'idle')
        sends = [c for c in self.bb.calls if c[1] == 'tell']
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0][2], 'thread-a')
        self.assertEqual(len(sends[0]), 4)
        self.assertNotIn('PRIVATE', self.path.read_text())
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_all_hosts_and_projects_included(self):
        other = self.bb.threads['thread-b']
        other['status'] = 'starting'
        self.pause.stop()
        self.pause.resume()
        self.assertEqual(len([c for c in self.bb.calls if c[1] == 'tell']), 2)

    def test_owner_change_after_stop_prevents_resume(self):
        self.pause.stop()
        self.bb.threads['thread-a']['updatedAt'] += 1
        self.pause.resume()
        self.assertFalse(any(c[1] == 'tell' for c in self.bb.calls))
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'changed-after-stop')

    def test_crash_after_stop_recovers_once(self):
        self.pause.stop()
        recovered = SessionPause(self.path, self.bb, lambda _: None, running=self.bb.running)
        recovered.recover()
        recovered.recover()
        self.assertEqual(len([c for c in self.bb.calls if c[1] == 'tell']), 1)

    def test_ambiguous_send_is_never_duplicated(self):
        self.pause.stop()
        self.bb.ambiguous_send = True
        with self.assertRaises(RuntimeError):
            self.pause.resume()
        with self.assertRaises(RuntimeError):
            SessionPause(self.path, self.bb, lambda _: None, running=self.bb.running).recover()
        self.assertEqual(len([c for c in self.bb.calls if c[1] == 'tell']), 1)

    def test_failed_stop_never_blindly_continues(self):
        self.bb.fail_stop = True
        with self.assertRaises(RuntimeError):
            self.pause.stop()
        with self.assertRaises(RuntimeError):
            self.pause.resume()
        self.assertFalse(any(c[1] == 'tell' for c in self.bb.calls))

    def test_completed_session_before_stop_is_not_interrupted(self):
        original = self.pause.show
        def changed(thread_id):
            self.bb.threads[thread_id].update(status='idle', updatedAt=2)
            return original(thread_id)
        self.pause.show = changed
        self.pause.stop()
        self.pause.resume()
        self.assertFalse(any(c[1] in ('stop', 'tell') for c in self.bb.calls))

    def test_resume_attempts_other_sessions_after_one_send_failure(self):
        self.bb.threads['thread-b']['status'] = 'active'
        self.pause.stop()
        self.bb.ambiguous_send = True
        with self.assertRaises(RuntimeError):
            self.pause.resume()
        self.assertEqual(len([c for c in self.bb.calls if c[1] == 'tell']), 2)

    def test_missing_metadata_refuses_before_stopping(self):
        self.bb.threads['thread-a'].pop('updatedAt')
        with self.assertRaises(ValueError):
            self.pause.stop()
        self.assertFalse(any(c[1] == 'stop' for c in self.bb.calls))

    def test_changed_execution_identity_during_stop_never_continues(self):
        original = self.pause.bb
        def mutate(*args):
            result = original(*args)
            if args[1] == 'stop':
                self.bb.threads[args[2]].update(environmentId='env-owner', providerId='provider-owner')
            return result
        self.pause.bb = mutate
        self.pause.stop()
        self.pause.resume()
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'changed-during-stop')
        self.assertFalse(any(c[1] == 'tell' for c in self.bb.calls))

    def test_bounded_cli_listing_cannot_omit_hidden_running_session(self):
        self.bb.threads['thread-b'].update(status='active', visibility='hidden')
        original = self.pause.bb
        def truncated_list(*args):
            if args[:2] == ('thread', 'list'):
                return [self.bb.threads['thread-a']]
            return original(*args)
        self.pause.bb = truncated_list
        self.pause.stop()
        self.pause.resume()
        self.assertEqual(len([c for c in self.bb.calls if c[1] == 'stop']), 2)

    def test_complete_inventory_failure_stops_nothing(self):
        def unavailable():
            raise RuntimeError('running API unavailable')
        self.pause.running = unavailable
        with self.assertRaises(RuntimeError):
            self.pause.stop()
        self.assertFalse(any(c[1] == 'stop' for c in self.bb.calls))

    def test_explicit_null_environment_is_valid_and_preserved(self):
        self.bb.threads['thread-a']['environmentId'] = None
        self.pause.stop()
        self.pause.resume()
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'resumed')
        self.assertIsNone(self.pause.state['sessions'][0]['stopped']['environmentId'])

    def test_missing_environment_field_refuses_before_any_stop(self):
        self.bb.threads['thread-a'].pop('environmentId')
        with self.assertRaises(ValueError):
            self.pause.stop()
        self.assertFalse(any(c[1] == 'stop' for c in self.bb.calls))

    def test_new_messages_stay_queued_until_owned_hold_is_released(self):
        self.pause.acquire_hold()
        self.pause.stop()
        self.bb('thread', 'tell', 'thread-b', 'synthetic queued user message')
        self.pause.resume()
        self.assertTrue(all(t['status'] == 'idle' for t in self.bb.threads.values()))
        self.pause.release_hold()
        self.assertTrue(all(t['status'] == 'active' for t in self.bb.threads.values()))

    def test_previous_receipt_without_queue_field_resumes_unchanged_session(self):
        self.pause.stop()
        entry = self.pause.state['sessions'][0]
        entry['before'].pop('queuedMessageCount')
        entry['stopped'].pop('queuedMessageCount')
        self.pause.save()
        self.pause.recover()
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'resumed')

    def test_previous_receipt_still_detects_new_queue_after_stop(self):
        self.pause.stop()
        entry = self.pause.state['sessions'][0]
        entry['stopped'].pop('queuedMessageCount')
        self.bb.threads['thread-a']['queuedMessageCount'] = 1
        self.pause.save()
        self.pause.recover()
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'changed-after-stop')
        self.assertFalse(any(c[1] == 'tell' for c in self.bb.calls))

    def test_preexisting_queued_work_gets_no_redundant_continuation(self):
        self.bb.threads['thread-a']['queuedMessageCount'] = 1
        self.pause.stop()
        self.pause.resume()
        self.assertFalse(any(c[1] == 'tell' for c in self.bb.calls))

    def test_foreign_or_short_hold_refuses_update(self):
        from pool_session_pause import verify_hold
        good = {'schemaVersion':1,'scope':'all-hosts-all-projects','lease':{'owner':'owner-a','expiresAt':1_800_000}}
        verify_hold(good,'owner-a',now=0)
        for owner, expires in [('owner-b',1_800_000),('owner-a',100),('owner-a',float('nan'))]:
            bad = {**good,'lease':{'owner':owner,'expiresAt':expires}}
            with self.assertRaises(RuntimeError):
                verify_hold(bad,'owner-a',now=0)

    def test_queue_arriving_between_snapshot_and_stop_does_not_skip_active_turn(self):
        self.pause.acquire_hold()
        original = self.pause.show
        calls = 0
        def queue_before_stop(thread_id):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.bb('thread', 'tell', thread_id, 'synthetic new user work')
            return original(thread_id)
        self.pause.show = queue_before_stop
        self.pause.stop()
        self.assertEqual(self.bb.threads['thread-a']['status'], 'idle')
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'stopped')
        self.assertEqual(self.bb.threads['thread-a']['queuedMessageCount'], 1)
        self.pause.resume()
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'queued-work-preserved')
        self.assertEqual(len([c for c in self.bb.calls if c[1] == 'tell']), 1)
        self.pause.release_hold()
        self.assertEqual(self.bb.threads['thread-a']['status'], 'active')

    def test_held_queue_timestamp_change_still_stops_same_execution(self):
        self.pause.acquire_hold()
        original = self.pause.show
        calls = 0
        def queue_before_stop(thread_id):
            nonlocal calls
            calls += 1
            if calls == 2:
                self.bb('thread', 'tell', thread_id, 'synthetic new user work')
                self.bb.threads[thread_id]['updatedAt'] += 1
            return original(thread_id)
        self.pause.show = queue_before_stop
        self.pause.stop()
        self.assertEqual(self.bb.threads['thread-a']['status'], 'idle')
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'stopped')
        self.pause.resume()
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'queued-work-preserved')
        self.pause.release_hold()
        self.assertEqual(self.bb.threads['thread-a']['status'], 'active')


class MaintenanceIntegrationTests(unittest.TestCase):
    def test_update_failure_still_continues_stopped_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / 'plugins' / upgrade.PLUGIN
            data.mkdir(parents=True)
            (data / 'data.db').touch()
            fake = FakeBB()
            def bb(*args):
                return {'dataDir': directory} if args == ('status',) else fake(*args)
            calls = []
            def perform(args, *rest):
                calls.append(args.check)
                if args.check:
                    return 'PREFLIGHT_PASS'
                self.assertEqual(fake.threads['thread-a']['status'], 'idle')
                raise RuntimeError('synthetic update failure')
            with patch('pool_session_pause.running_threads', fake.running), patch.object(upgrade, 'bb', side_effect=bb), patch.object(upgrade, 'perform', side_effect=perform), patch.object(upgrade.sys, 'argv', ['upgrade', '--pause-sessions']), patch.dict(upgrade.os.environ, {'BB_SERVER_URL': 'http://127.0.0.1'}), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(upgrade.main(), 1)
            self.assertEqual(calls, [True, False])
            self.assertEqual(fake.threads['thread-a']['status'], 'active')

    def test_preflight_failure_never_stops_sessions(self):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'plugins' / upgrade.PLUGIN
            data.mkdir(parents=True)
            (data / 'data.db').touch()
            fake = FakeBB()
            def bb(*args):
                return {'dataDir': directory} if args == ('status',) else fake(*args)
            with patch('pool_session_pause.running_threads', fake.running), patch.object(upgrade, 'bb', side_effect=bb), patch.object(upgrade, 'perform', side_effect=RuntimeError('preflight failed')), patch.object(upgrade.sys, 'argv', ['upgrade', '--pause-sessions']), patch.dict(upgrade.os.environ, {'BB_SERVER_URL': 'http://127.0.0.1'}), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(upgrade.main(), 1)
            self.assertFalse(any(c[1] == 'stop' for c in fake.calls))


if __name__ == '__main__':
    unittest.main()
