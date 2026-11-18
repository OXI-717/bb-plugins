import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import catalog_audit


class AuditPublicationTests(unittest.TestCase):
    def test_push_follows_publication_and_existing_dedup(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'inventory.json'
            config.write_text(json.dumps(dict(
                host='host', hosts=['host'], sourceId='audit', name='Inventory',
                owner='Operator', staleAfterMs=60000, notifyMissingRequired=True,
                registry=[dict(host='host', scheduler='systemd', scope='user',
                               unit='expected.timer', expectedPresent=True)],
            )))
            state = config.with_name('audit-state.json')
            calls = []
            reject = True

            def command(argv, **kwargs):
                if 'catalog_list' in argv:
                    return subprocess.CompletedProcess(argv, 0, '{"sources":[],"tasks":[]}')
                if 'catalog_publish' in argv:
                    return subprocess.CompletedProcess(argv, 0, json.dumps({'ok': not reject}))
                self.assertEqual(argv[1:3], ['push-notifications', 'send'])
                self.assertTrue(any(item['active'] for item in json.loads(state.read_text()).values()))
                calls.append(argv)
                return subprocess.CompletedProcess(argv, 0, '{"ok":true,"channels":["web"]}')

            inventory = dict(coverage=[dict(scheduler='systemd', scope='user', ok=True)],
                             observations=[])
            stdout = io.StringIO()
            with patch('sys.argv', ['audit', '--config', str(config), '--publish']), \
                    patch('catalog_audit.discover', return_value=inventory), \
                    patch('catalog_audit.subprocess.run', side_effect=command), \
                    contextlib.redirect_stdout(stdout):
                with self.assertRaisesRegex(RuntimeError, 'publication|rejected'):
                    catalog_audit.main()
                self.assertFalse(state.exists())
                self.assertEqual(calls, [])
                reject = False
                self.assertEqual(catalog_audit.main(), 0)
                self.assertEqual(catalog_audit.main(), 0)
            first, second = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(first['notification'], {'status': 'accepted', 'channels': ['web']})
            self.assertNotIn('notification', second)
            self.assertEqual(len(calls), 1)

    def test_notification_failure_distinguishes_no_channel_from_unknown(self):
        findings = {'key': {'kind': 'missing-required'}}
        events = [{'taskId': 'key', 'status': 'failed'}]
        with patch('catalog_audit.subprocess.run') as send:
            send.return_value = subprocess.CompletedProcess([], 1, '{"error":{"code":"not_delivered"}}')
            self.assertEqual(catalog_audit.notify_required_findings('bb', findings, events),
                             {'status': 'no-channel'})
            send.side_effect = subprocess.TimeoutExpired('bb', 15)
            self.assertEqual(catalog_audit.notify_required_findings('bb', findings, events),
                             {'status': 'unconfirmed'})
            self.assertEqual(send.call_count, 2)
            self.assertIsNone(catalog_audit.notify_required_findings('bb', findings, []))
