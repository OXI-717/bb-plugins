import json
import unittest
from unittest.mock import Mock
import catalog_systemd as s
from catalog_collect import task_base

ID = 'a' * 32
TIMER = 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nTimersCalendar=OnCalendar=hourly\nNextElapseUSecRealtime=Fri 2026-11-06 17:00:00 UTC'
SERVICE = f'LoadState=loaded\nActiveState=inactive\nResult=success\nInvocationID={ID}\nExecMainCode=1\nExecMainStatus=0\nExecMainStartTimestamp=Fri 2026-11-06 16:00:00 UTC\nExecMainExitTimestamp=Fri 2026-11-06 16:00:01 UTC'
SELECTION = {'system:example.timer': {'name': 'Example cleanup', 'service': 'example.service'}}

class SystemdTests(unittest.TestCase):
    def test_latest_result_with_inaccessible_journal_is_honest(self):
        read = Mock(side_effect=[TIMER, SERVICE, RuntimeError('denied')])
        tasks, runs = s.collect('worker', SELECTION, read, task_base)
        self.assertEqual(tasks[0]['state'], 'active')
        self.assertEqual(runs[0]['status'], 'succeeded')
        self.assertIn('Journal unavailable', runs[0]['summary'])
        self.assertEqual(runs[0]['id'], 'systemd:' + ID)
        self.assertTrue(tasks[0]['nextRunAt'] > runs[0]['finishedAt'])
        self.assertFalse(any('sudo' in argv for argv in [call.args[0] for call in read.call_args_list]))

    def test_only_known_counters_are_exported(self):
        data = dict(eligible=['PRIVATE'], kept=[], removed=['PRIVATE'], errors=[], removed_allocated_bytes=4096)
        event = {'_SYSTEMD_INVOCATION_ID': ID, 'MESSAGE': json.dumps(data)}
        read = Mock(side_effect=[TIMER, SERVICE, json.dumps(event)])
        _, runs = s.collect('worker', SELECTION, read, task_base)
        self.assertIn('4096', runs[0]['summary'])
        self.assertNotIn('PRIVATE', str(runs))

    def test_never_infers_execution_from_enabled_timer(self):
        read = Mock(side_effect=[TIMER, 'LoadState=loaded\nResult=success\nExecMainStatus=0'])
        tasks, runs = s.collect('worker', SELECTION, read, task_base)
        self.assertEqual(runs, [])
        self.assertEqual(tasks[0]['history'], 'not-recorded')

    def test_failure_and_pause_are_distinct(self):
        read = Mock(side_effect=[TIMER.replace('enabled', 'disabled').replace('active', 'inactive'),
                                SERVICE.replace('Result=success', 'Result=exit-code').replace('ExecMainStatus=0','ExecMainStatus=2'), ''])
        tasks, runs = s.collect('worker', SELECTION, read, task_base)
        self.assertEqual(tasks[0]['state'], 'paused')
        self.assertEqual(runs[0]['status'], 'failed')
        self.assertEqual(runs[0]['exitCode'], 2)

    def test_rejects_wildcards_and_command_injection(self):
        for key in ('system:*.timer', 'system:foo.timer;id', 'example.timer'):
            read = Mock()
            with self.assertRaises(ValueError):
                s.collect('worker', {key: {'name': 'Bad'}}, read, task_base)
            read.assert_not_called()

    def test_new_invocation_does_not_reuse_previous_completion(self):
        live = SERVICE.replace('ActiveState=inactive', 'ActiveState=activating').replace('16:00:01 UTC', '15:00:01 UTC')
        _, runs = s.collect('worker', SELECTION, Mock(side_effect=[TIMER, live, '']), task_base)
        self.assertEqual(runs[0]['status'], 'running')
        self.assertIsNone(runs[0]['finishedAt'])

    def test_unknown_timestamp_is_unknown(self):
        self.assertIsNone(s.timestamp('n/a'))
        self.assertIsNone(s.timestamp('Fri 2026-11-06 16:00:00 Invalid/Zone'))

if __name__ == '__main__':
    unittest.main()

class StandaloneTests(unittest.TestCase):
    def test_long_running_service_has_no_invented_schedule(self):
        live=SERVICE.replace('ActiveState=inactive','ActiveState=active').replace('ExecMainExitTimestamp=Fri 2026-11-06 16:00:01 UTC','ExecMainExitTimestamp=')
        tasks,runs=s.collect('worker',{'user:example.service':{'name':'Example service'}},Mock(side_effect=[live,'']),task_base)
        self.assertEqual(tasks[0]['state'],'active')
        self.assertIsNone(tasks[0]['schedule'])
        self.assertIsNone(tasks[0]['nextRunAt'])
        self.assertEqual(runs[0]['status'],'running')
    def test_timer_companion_cannot_be_separate_card(self):
        with self.assertRaises(ValueError):
            s.collect('worker',{'system:example.timer':{'name':'Example'},'system:example.service':{'name':'Duplicate'}},Mock(),task_base)
