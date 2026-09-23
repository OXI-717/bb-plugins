import unittest
import json
import os
import plistlib
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch
import catalog_collect as c

class CollectorTests(unittest.TestCase):
    def test_bb_import_reads_source_without_copying_execution_payloads(self):
        overview = {'automations': [{'project': {'id': 'proj_personal', 'name': 'Personal'}, 'automation': {
            'id': 'a1', 'name': 'Watch', 'enabled': True,
            'trigger': {'triggerType': 'schedule', 'cron': '0 * * * *', 'timezone': 'UTC'},
            'execution': {'mode': 'script', 'interpreter': 'python3', 'script': 'PRIVATE'},
        }}]}
        history = {'runs': [{'id': 'r1', 'status': 'skipped', 'skipReason': 'empty output', 'startedAt': 100, 'finishedAt': 200, 'exitCode': 0, 'output': 'PRIVATE'}]}
        with patch.object(c, 'command', side_effect=[json.dumps(overview), json.dumps(history)]) as read:
            tasks, runs = c.bb_collect('http://source:1234', 'Mac')
        self.assertEqual(tasks[0]['scheduler'], 'bb')
        self.assertEqual(tasks[0]['scope'], 'personal')
        self.assertEqual(runs[0]['status'], 'skipped')
        self.assertEqual(runs[0]['finishedAt'], 200)
        self.assertNotIn('PRIVATE', str((tasks, runs)))
        self.assertTrue(all(call.kwargs['env']['BB_SERVER_URL'] == 'http://source:1234' for call in read.call_args_list))

    def test_local_registry_excludes_unselected_oxi_services_and_cron(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = []
            for label in ['org.example.weekly-report', 'org.example.mem-guard', 'com.vendor.updater']:
                path = Path(directory) / (label + '.plist')
                path.write_bytes(plistlib.dumps(dict(Label=label, StartInterval=300, ProgramArguments=['/bin/true'])))
                paths.append(path)
            selection = {f'gui/{os.getuid()}:org.example.weekly-report': 'Weekly report'}
            cron = subprocess.CompletedProcess([], 0, '0 3 * * 0 docker prune\n', '')
            with patch.object(c.Path, 'glob', return_value=paths), patch.object(c, 'command', return_value='state = waiting'), patch.object(c.subprocess, 'run', return_value=cron):
                tasks = c.local_tasks('mac', selection=selection)
                self.assertEqual([task['name'] for task in tasks], ['Weekly report'])
                self.assertEqual(c.local_tasks('mac'), [])

    def test_cron_identity_survives_comment_and_order_changes(self):
        line = '0 3 * * 0 docker prune --secret NEVER_EXPORT'
        one = c.cron_tasks(line, 'mac', 'operator')[0]
        two = c.cron_tasks('# comment\n\n' + line, 'mac', 'operator')[0]
        self.assertEqual(one['id'], two['id'])
        self.assertNotIn('NEVER_EXPORT', str(one))
        self.assertEqual(one['history'], 'not-recorded')

    def test_cron_inline_environment_is_not_exported(self):
        row = c.cron_tasks('0 1 * * * API_TOKEN=NEVER_EXPORT /bin/job --password hidden', 'mac', 'operator')[0]
        self.assertEqual(row['executor'], 'job')
        self.assertNotIn('NEVER_EXPORT', str(row))
        self.assertNotIn('hidden', str(row))

    def test_cron_alias_and_environment_lines(self):
        rows = c.cron_tasks('MAILTO=user\n@reboot /usr/bin/job\n', 'mac', 'operator')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['schedule'], '@reboot (host timezone)')

    def test_registry_scope_is_independent_of_host_and_excludes_restricted(self):
        tasks = c.registry_tasks({'automations': [
            {'id': 'one', 'title': 'One', 'scope': 'personal', 'visibility': 'team-metadata', 'runtime': {'host_id': 'team-server', 'scheduler': 'systemd'}, 'state': 'active'},
            {'id': 'private', 'scope': 'team', 'visibility': 'team-private', 'runtime': {'host_id': 'same'}},
        ]}, 'Example Team')
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]['scope'], 'personal')
        self.assertEqual(tasks[0]['state'], 'unknown')

    def test_private_registry_projection_requires_explicit_selection(self):
        registry = {'automations': [{'id': 'private', 'title': 'Private', 'scope': 'personal', 'visibility': 'private', 'runtime': {'host_id': 'mine'}}]}
        self.assertEqual(c.registry_tasks(registry, None), [])
        self.assertEqual(len(c.registry_tasks(registry, None, include_private=True)), 1)

    def test_run_mapping_does_not_invent_start_or_copy_results(self):
        run = c.aim_run({'id': 'r1', 'task_id': 't1', 'state': 'queued', 'created_at': '2026-09-21T00:00:00Z', 'result': 'PRIVATE'}, 'server', False)
        self.assertIsNone(run['startedAt'])
        self.assertIsNone(run['summary'])

if __name__ == '__main__':
    unittest.main()
