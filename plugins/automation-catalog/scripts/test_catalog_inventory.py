import unittest
import tempfile
from catalog_inventory import discover

class InventoryTests(unittest.TestCase):
    def test_only_identity_not_commands(self):
        def run(argv):
            if argv[0]=='crontab':return '* * * * * SECRET=value private-command --private-argument\n'
            return 'example.service enabled enabled\nexample.timer enabled enabled\n'
        with tempfile.TemporaryDirectory() as root:
            actual=discover(run,system='Linux',etc=root)
        self.assertNotIn('SECRET',str(actual))
        self.assertNotIn('private-command',str(actual))
        self.assertGreaterEqual(len(actual['coverage']),3)
        self.assertTrue(all(c['ok'] for c in actual['coverage'] if c['scope'] != 'root'))
    def test_failure_is_unknown(self):
        def run(argv):raise RuntimeError('denied')
        with tempfile.TemporaryDirectory() as root:
            actual=discover(run,system='Linux',etc=root)
        self.assertEqual(actual['observations'],[])
        self.assertTrue(all(not c['ok'] for c in actual['coverage'] if c['scope'] != 'system' or c['scheduler'] != 'cron'))

if __name__=='__main__':unittest.main()

class ExportTests(unittest.TestCase):
    def test_standalone_export_retains_actual_collection_time(self):
        import io,json,runpy,subprocess,time
        from pathlib import Path
        from unittest.mock import patch
        output=io.StringIO()
        before=int(time.time()*1000)
        with patch('platform.system',return_value='Synthetic'), patch('subprocess.run',return_value=subprocess.CompletedProcess([],0,'','')),patch('sys.stdout',output):
            runpy.run_path(str(Path(__file__).with_name('catalog_inventory.py')),run_name='__main__')
        data=json.loads(output.getvalue())
        self.assertGreaterEqual(data['observedAt'],before)
        self.assertLessEqual(data['observedAt'],int(time.time()*1000))

class CronIdentityTests(unittest.TestCase):
    def test_observed_and_collector_cron_identities_match(self):
        from catalog_collect import cron_tasks
        from tempfile import TemporaryDirectory
        content='CRON_TZ=UTC\n5 * * * * /usr/bin/example --argument=value\n'
        with TemporaryDirectory() as root:
            data=discover(lambda argv:content if argv[0]=='crontab' else '',system='Linux',etc=root)
        ids=[r['unit'] for r in data['observations'] if r['scheduler']=='cron']
        self.assertEqual(ids,[t['id'] for t in cron_tasks(content,'sample','operator')])

class LoadedDependencyTests(unittest.TestCase):
    def test_missing_dependency_is_not_an_installed_service(self):
        def run(argv):
            if 'list-unit-files' in argv:
                return 'present.service disabled enabled\n'
            if 'list-units' in argv:
                return ('missing.service not-found inactive dead Missing dependency\n'
                        'transient.service loaded active running Actual transient\n'
                        'broken.service error inactive dead Broken unit\n'
                        'orphan-running.service not-found active running Retained process\n'
                        'orphan-failed.service not-found failed failed Retained failure\n')
            return ''
        with tempfile.TemporaryDirectory() as root:
            data=discover(run,system='Linux',etc=root)
        names={r['unit'] for r in data['observations']}
        self.assertNotIn('missing.service',names)
        self.assertIn('present.service',names)
        self.assertIn('transient.service',names)
        self.assertIn('broken.service',names)
        self.assertIn('orphan-running.service',names)
        self.assertIn('orphan-failed.service',names)

class InertPlistTests(unittest.TestCase):
    def test_empty_vendor_placeholder_is_not_a_service(self):
        from catalog_inventory import launchd_label
        self.assertIsNone(launchd_label({}, 'vendor-placeholder'))
        self.assertEqual(launchd_label({'Label':'sample','Program':'/bin/true'},'file'), 'sample')
        # Executable but incomplete definitions stay visible for diagnosis.
        self.assertEqual(launchd_label({'Program':'/bin/true'},'broken'), 'broken')
