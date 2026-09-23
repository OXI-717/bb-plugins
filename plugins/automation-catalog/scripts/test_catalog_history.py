from contextlib import closing
import json
import tempfile
import unittest
from pathlib import Path
import catalog_history as h

class HistoryTests(unittest.TestCase):
    def test_exit_receipt_has_no_invented_times_and_is_stable(self):
        with tempfile.TemporaryDirectory() as folder, closing(h.LaunchLedger(Path(folder) / 'state.json')) as ledger:
            rows = ledger.observe('host', 'gui/501/job', 'boot', {'runs': '3', 'last exit code': '1', 'state': 'not running'})
            self.assertEqual(rows[0]['status'], 'failed')
            self.assertIsNone(rows[0]['startedAt'])
            self.assertIsNone(rows[0]['finishedAt'])
            self.assertEqual(rows[0]['id'], ledger.observe('host', 'gui/501/job', 'boot', {'runs': '3', 'last exit code': '1'})[0]['id'])
            reset = ledger.observe('host', 'gui/501/job', 'boot', {'runs': '1', 'last exit code': '0'})
            self.assertNotEqual(reset[0]['id'], rows[0]['id'])

    def test_running_process_does_not_inherit_previous_failure(self):
        with tempfile.TemporaryDirectory() as folder, closing(h.LaunchLedger(Path(folder) / 'state.json')) as ledger:
            rows = ledger.observe('host', 'job', 'boot', {'runs': '2', 'pid': '123', 'state': 'running', 'last exit code': '1'})
            self.assertEqual(rows[-1]['status'], 'running')
            self.assertIsNone(rows[-1]['exitCode'])
            self.assertEqual(rows[0]['status'], 'failed')

    def test_log_state_change_is_not_a_successful_execution(self):
        event = {'eventMessage': 'service inactive: org.example.job', 'subsystem': 'gui/501 [100017]', 'bootUUID': 'b', 'machTimestamp': 123, 'timestamp': '2026-09-21 13:16:19.656857+0300'}
        rows = h.launch_events([event], {'gui/501:org.example.job'}, 'host')
        self.assertEqual(rows[0]['evidence'], 'state-change')
        self.assertEqual(rows[0]['status'], 'unknown')
        self.assertEqual(rows[0]['finishedAt'], 1789985779656)
        self.assertEqual(h.launch_events([event], {'system:org.example.job'}, 'host'), [])

    def test_zero_runs_does_not_create_history(self):
        with tempfile.TemporaryDirectory() as folder, closing(h.LaunchLedger(Path(folder) / 'state.json')) as ledger:
            self.assertEqual(ledger.observe('host', 'job', 'boot', {'runs':'0','last exit code':'0'}), [])

if __name__ == '__main__':
    unittest.main()
