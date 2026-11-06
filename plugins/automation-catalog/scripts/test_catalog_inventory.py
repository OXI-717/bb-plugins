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
        self.assertTrue(all(c['ok'] for c in actual['coverage']))
    def test_failure_is_unknown(self):
        def run(argv):raise RuntimeError('denied')
        with tempfile.TemporaryDirectory() as root:
            actual=discover(run,system='Linux',etc=root)
        self.assertEqual(actual['observations'],[])
        self.assertTrue(all(not c['ok'] for c in actual['coverage'] if c['scope'] != 'system' or c['scheduler'] != 'cron'))

if __name__=='__main__':unittest.main()
