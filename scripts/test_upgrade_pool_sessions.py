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
        self.model_lease = None
        self.fail_stop = False
        self.ambiguous_send = False

    def running(self):
        return [{"id": t["id"], "hostId": None} for t in self.threads.values()
                if t["status"] in ("active", "starting")]

    def __call__(self, *args):
        self.calls.append(args)
        if args[:2] == ('pool', 'maintenance'):
            if args[2] in ('acquire', 'acquire-upgrade'):
                self.model_lease = {'owner': args[4], 'expiresAt': time.time()*1000+1_800_000}
                if args[2] == 'acquire-upgrade':
                    self.model_lease['upgrade'] = 'draining'
            elif args[2] == 'release':
                if self.model_lease and self.model_lease['owner'] != args[4]:
                    raise RuntimeError('foreign pause')
                self.model_lease = None
            elif args[2] == 'interrupt':
                if not self.model_lease or self.model_lease['owner'] != args[4]:
                    raise RuntimeError('foreign pause')
            return {'schemaVersion': 1, 'scope': 'all-model-clients', 'transportInFlight': 0, 'lease': self.model_lease, 'nativeDrain': True}
        if args[0] == 'pool-maintenance':
            if args[1] in ('acquire', 'acquire-drain'):
                duration = 3_600_000 if args[1] == 'acquire-drain' else 1_800_000
                self.lease = {'owner': args[3], 'expiresAt': time.time()*1000+duration}
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
        self.assertEqual(sends[0][-2:], ('--mode', 'auto'))
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
        self.pause.resume()
        SessionPause(self.path, self.bb, lambda _: None, running=self.bb.running).recover()
        self.assertEqual(self.pause.state['sessions'][0]['action'], 'resumed')
        self.assertEqual(len([c for c in self.bb.calls if c[1] == 'tell']), 1)

    def test_lost_continuation_is_retried_and_confirmed(self):
        self.pause.stop()
        sends = []
        def lose_first(*args):
            if args[:2] == ('thread', 'tell'):
                sends.append(args)
                if len(sends) == 1:
                    return {'delivery': 'sent'}
            return self.bb(*args)
        self.pause.bb = lose_first
        self.pause.sleep = lambda _: None
        self.pause.resume()
        self.assertEqual(len(sends), 2)
        self.assertEqual(sends[-1][-2:], ('--mode', 'auto'))
        self.assertEqual(self.bb.threads['thread-a']['status'], 'active')
        self.assertEqual(self.pause.state['uncontinuedThreads'], [])

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
        def no_delivery(*args):
            if args[:3] == ('thread', 'tell', 'thread-a'):
                self.bb.calls.append(args)
                raise TimeoutError()
            return self.bb(*args)
        self.pause.bb = no_delivery
        self.pause.sleep = lambda _: None
        with self.assertRaises(RuntimeError):
            self.pause.resume()
        self.assertEqual(len([c for c in self.bb.calls if c[1] == 'tell']), 3)
        self.assertEqual(self.pause.state['uncontinuedThreads'], [
            {'id': 'thread-a', 'reason': 'resume-unconfirmed'}
        ])
        self.assertEqual(self.bb.threads['thread-b']['status'], 'active')

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
                self.assertIsNotNone(fake.lease)
                self.assertEqual(fake.model_lease.get('upgrade'), 'draining')
                fake.threads['thread-b']['queuedMessageCount'] = 2
                raise upgrade.UpgradeError('Idle wait expired; nothing updated')
            with patch('pool_session_pause.running_threads', fake.running), patch.object(upgrade, 'bb', side_effect=bb), patch.object(upgrade, 'perform', side_effect=perform), patch.object(upgrade.sys, 'argv', ['upgrade', '--pause-sessions']), patch.dict(upgrade.os.environ, {'BB_SERVER_URL': 'http://127.0.0.1'}), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(upgrade.main(), 1)
            self.assertEqual(calls, [True, False])
            self.assertIsNone(fake.model_lease)
            self.assertIsNone(fake.lease)
            self.assertEqual(fake.threads['thread-a']['status'], 'active')
            self.assertEqual(fake.threads['thread-b']['status'], 'active')
            self.assertEqual(fake.threads['thread-b']['queuedMessageCount'], 0)
            self.assertFalse(any(c[:3] == ('pool','maintenance','interrupt') for c in fake.calls))
            actions = [c[:3] for c in fake.calls]
            model_release = actions.index(('pool', 'maintenance', 'release'))
            dispatch_release = next(i for i, c in enumerate(actions) if c[:2] == ('pool-maintenance', 'release'))
            continue_turn = actions.index(('thread', 'tell', 'thread-a'))
            self.assertLess(model_release, dispatch_release)
            self.assertLess(dispatch_release, continue_turn)

    def test_missing_model_pause_api_never_holds_queue_or_stops_sessions(self):
        for response in (None, {}, {'schemaVersion': 1, 'scope': 'all-hosts-all-projects'}):
            with self.subTest(response=response), tempfile.TemporaryDirectory() as directory:
                data = Path(directory) / 'plugins' / upgrade.PLUGIN
                data.mkdir(parents=True)
                (data / 'data.db').touch()
                fake = FakeBB()
                def bb(*args):
                    if args == ('status',):
                        return {'dataDir': directory}
                    if args == ('pool', 'maintenance', 'status'):
                        if response is None:
                            raise RuntimeError('Unknown legacy command')
                        return response
                    return fake(*args)
                with patch.object(upgrade, 'bb', side_effect=bb), patch.object(upgrade, 'perform', return_value='PREFLIGHT_PASS') as perform, patch.object(upgrade.sys, 'argv', ['upgrade', '--pause-sessions']), patch.dict(upgrade.os.environ, {'BB_SERVER_URL': 'http://127.0.0.1'}), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(upgrade.main(), 1)
                self.assertEqual(perform.call_count, 1)
                self.assertEqual(fake.calls, [])
                self.assertIsNone(fake.lease)

    def test_model_pause_precedes_stop_and_release_failure_still_cleans_queue(self):
        for fail_release in (False, True):
            with self.subTest(fail_release=fail_release), tempfile.TemporaryDirectory() as directory:
                data = Path(directory) / 'plugins' / upgrade.PLUGIN
                data.mkdir(parents=True)
                (data / 'data.db').touch()
                fake = FakeBB()
                def bb(*args):
                    if args == ('status',):
                        return {'dataDir': directory}
                    if args[:3] == ('pool', 'maintenance', 'acquire-upgrade'):
                        self.assertEqual(fake.threads['thread-a']['status'], 'active')
                        receipt = next((Path(directory) / 'backups').glob('*/sessions.json'))
                        self.assertEqual(json.loads(receipt.read_text())['sessions'], [])
                    if fail_release and args[:3] == ('pool', 'maintenance', 'release'):
                        raise RuntimeError('synthetic model release failure')
                    return fake(*args)
                with patch('pool_session_pause.running_threads', fake.running), patch.object(upgrade, 'bb', side_effect=bb), patch.object(upgrade, 'perform', side_effect=lambda args, *rest: 'PREFLIGHT_PASS' if args.check else 'UPGRADED'), patch.object(upgrade.sys, 'argv', ['upgrade', '--pause-sessions']), patch.dict(upgrade.os.environ, {'BB_SERVER_URL': 'http://127.0.0.1'}), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(upgrade.main(), int(fail_release))
                self.assertIsNone(fake.lease)
                self.assertEqual(fake.threads['thread-a']['status'], 'active')
                self.assertEqual(len([c for c in fake.calls if c[:2] == ('thread', 'tell')]), 1)

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


class ModelMaintenanceTests(unittest.TestCase):
    setUp = SessionPauseTests.setUp
    def test_recovery_model_release_failure_still_attempts_continuation_and_queue_release(self):
        self.pause.acquire_hold()
        self.pause.stop()
        self.pause.acquire_model_hold()
        original = self.bb
        def failed(*args):
            if args[:3] == ('pool', 'maintenance', 'status'):
                raise RuntimeError('synthetic unavailable pool')
            return original(*args)
        recovered = SessionPause(self.path, failed, lambda _: None, running=self.bb.running)
        with self.assertRaisesRegex(RuntimeError, 'unavailable pool'):
            recovered.recover()
        self.assertIsNone(self.bb.lease)
        self.assertEqual(self.bb.threads['thread-a']['status'], 'active')

    def test_both_barriers_restore_in_order_and_preserve_foreign_pauses(self):
        self.pause.acquire_hold()
        self.pause.acquire_model_hold()
        self.pause.stop()
        self.pause.interrupt_model_requests()
        self.assertEqual(self.bb.threads['thread-a']['status'], 'idle')
        self.assertIsNotNone(self.bb.model_lease)
        self.pause.release_model_hold()
        self.pause.resume()
        self.pause.release_hold()
        self.assertIsNone(self.bb.model_lease)
        self.assertIsNone(self.bb.lease)
        release = next(i for i, c in enumerate(self.bb.calls) if c[:3] == ('pool', 'maintenance', 'release'))
        send = next(i for i, c in enumerate(self.bb.calls) if c[:2] == ('thread', 'tell'))
        self.assertLess(release, send)
        self.assertEqual(self.bb.threads['thread-a']['status'], 'active')

    def test_recovery_releases_only_its_model_pause_before_continuing(self):
        self.pause.acquire_hold()
        self.pause.acquire_model_hold()
        self.pause.stop()
        self.bb.model_lease['owner'] = 'foreign-operation'
        self.pause.recover()
        self.assertEqual(self.bb.model_lease['owner'], 'foreign-operation')
        self.assertFalse(any(c[:3] == ('pool', 'maintenance', 'release') for c in self.bb.calls))

    def test_crash_after_model_pause_receipt_recovers_without_duplicate_send(self):
        self.pause.acquire_hold()
        self.pause.acquire_model_hold()
        self.pause.stop()
        recovered = SessionPause(self.path, self.bb, lambda _: None, running=self.bb.running)
        recovered.recover()
        recovered.recover()
        self.assertIsNone(self.bb.model_lease)
        self.assertEqual(len([c for c in self.bb.calls if c[:2] == ('thread', 'tell')]), 1)

    def test_missing_or_expiring_model_barrier_refuses_update(self):
        from pool_session_pause import verify_model_hold
        good = {'schemaVersion': 1, 'scope': 'all-model-clients', 'transportInFlight': 0, 'lease': {'owner': 'owner-a', 'expiresAt': 1_800_000}}
        verify_model_hold(good, 'owner-a', now=0)
        for bad in [None, {}, {**good, 'scope': 'all-hosts-all-projects'}, {**good, 'lease': None}, {**good, 'lease': {'owner':'owner-a','expiresAt':899_999}}]:
            with self.assertRaises(RuntimeError):
                verify_model_hold(bad, 'owner-a', now=0)

    def test_idle_refusal_names_uncertain_native_lease_without_releasing_it(self):
        times = iter([0, 0, 0, 1, 2, 3])
        lease_id = '11111111-1111-4111-8111-111111111111'
        lease = {'state': 'uncertain', 'executorId': 'example-executor', 'kind': 'catalog',
                 'id': lease_id, 'createdAt': 175_000}
        def bb(*args):
            if args == ('pool', 'native', 'status'):
                return {'leases': [lease]}
            self.assertEqual(args, ('pool', 'status'))
            return {'inFlight': 0, 'accounts': []}
        with patch.object(upgrade, 'bb', side_effect=bb), patch.object(upgrade, 'model_activity', return_value=0), patch.object(upgrade.time, 'sleep'), patch.object(upgrade, 'report_pool'), patch.object(upgrade.time, 'monotonic', side_effect=lambda:next(times)), patch.object(upgrade.time, 'time', return_value=300):
            with self.assertRaises(upgrade.UpgradeError) as error:
                upgrade.wait_idle(lambda _: None, offer_interrupt=False, deadline_seconds=2, include_native=True)
            self.assertIn('example-executor (catalog), age 125 s', str(error.exception))
            self.assertIn(f'bb pool native attest-stopped {lease_id} --confirmed', str(error.exception))


class GracefulDrainTests(unittest.TestCase):
    setUp = SessionPauseTests.setUp

    def test_natural_completion_never_stops_or_sends_continuations(self):
        self.pause.acquire_hold()
        ticks = [0]
        def sleep(_):
            ticks[0] += 1
            self.bb.threads['thread-a']['status'] = 'idle'
        self.pause.sleep = sleep
        self.pause.clock = lambda: ticks[0]
        self.pause.drain(lambda: True, 10)
        self.pause.release_hold()
        self.assertFalse(any(c[:2] in [('thread', 'stop'), ('thread', 'tell')] for c in self.bb.calls))
        self.assertEqual(self.pause.state['sessions'], [])

    def test_busy_or_unknown_drain_refuses_without_model_hold(self):
        self.pause.acquire_hold()
        ticks = [0]
        self.pause.sleep = lambda _: ticks.__setitem__(0, ticks[0]+1)
        self.pause.clock = lambda: ticks[0]
        with self.assertRaisesRegex(RuntimeError, 'drain expired'):
            self.pause.drain(lambda: True, 4)
        self.assertFalse(any(c[:2] == ('thread', 'stop') or c[:3] == ('pool', 'maintenance', 'acquire') for c in self.bb.calls))
        self.pause.release_hold()

    def test_model_drain_has_no_interrupt_fallback(self):
        def unsupported(*args):
            if args[:3] == ('pool', 'maintenance', 'acquire-upgrade'):
                raise RuntimeError('unsupported')
            return self.bb(*args)
        self.pause.bb = unsupported
        with self.assertRaisesRegex(RuntimeError, 'unsupported'):
            self.pause.acquire_model_hold('acquire-upgrade')
        self.assertEqual(self.pause.state['modelAdmission'], 'acquire-intent')
        self.assertFalse(any(c[:3] in [('pool', 'maintenance', 'acquire'), ('pool', 'maintenance', 'interrupt')] for c in self.bb.calls))


class GracefulMainTests(unittest.TestCase):
    def run_drain(self, *, legacy=False):
        with tempfile.TemporaryDirectory() as directory:
            data = Path(directory) / 'plugins' / upgrade.PLUGIN
            data.mkdir(parents=True)
            (data / 'data.db').touch()
            fake = FakeBB()
            fake.threads['thread-a']['status'] = 'idle'
            native_checks = 0

            def bb(*args):
                nonlocal native_checks
                if args == ('status',):
                    return {'dataDir': directory}
                if args == ('pool', 'maintenance', 'status') and legacy:
                    return {'schemaVersion': 1, 'scope': 'all-model-clients', 'transportInFlight': 0, 'lease': None}
                if args == ('pool', 'native', 'status'):
                    native_checks += 1
                    state = 'active' if native_checks == 1 else 'queued'
                    return {'leases': [{'state': state}]}
                if args[:3] == ('pool', 'maintenance', 'acquire-upgrade'):
                    self.assertEqual(native_checks, 4)
                    self.assertIsNotNone(fake.lease)
                return fake(*args)

            def perform(args, *_rest):
                if args.check:
                    return 'PREFLIGHT_PASS'
                self.assertEqual(fake.model_lease.get('upgrade'), 'draining')
                return 'PASS'

            with patch.object(upgrade, 'bb', side_effect=bb), \
                 patch.object(upgrade, 'perform', side_effect=perform) as install, \
                 patch('pool_session_pause.running_threads', fake.running), \
                 patch('pool_session_pause.time.sleep'), \
                 patch.object(upgrade.sys, 'argv', ['upgrade', '--drain-sessions', '--drain-timeout', '2400']), \
                 patch.dict(upgrade.os.environ, {'BB_SERVER_URL': 'http://127.0.0.1'}), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(upgrade.main(), int(legacy))
                self.assertEqual(install.call_count, 1 if legacy else 2)
            self.assertIsNone(fake.lease)
            self.assertIsNone(fake.model_lease)
            return fake.calls

    def test_drain_waits_for_warm_native_cleanup_without_stopping_or_replaying(self):
        calls = self.run_drain()
        self.assertTrue(any(c[:2] == ('pool-maintenance', 'acquire-drain') for c in calls))
        self.assertTrue(any(c[:3] == ('pool', 'maintenance', 'acquire-upgrade') for c in calls))
        self.assertFalse(any(c[:2] in [('thread', 'stop'), ('thread', 'tell')] for c in calls))

    def test_legacy_pool_is_refused_before_taking_a_hold(self):
        self.assertEqual(self.run_drain(legacy=True), [])


if __name__ == '__main__':
    unittest.main()
