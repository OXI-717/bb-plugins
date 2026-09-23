import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import catalog_sync


class SyncTests(unittest.TestCase):
    def test_success_waits_for_interval_and_failure_remains_due(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text(json.dumps(dict(enabled=True, serverUrl='http://127.0.0.1:1234', sources=[
                dict(id='local', name='Local', kind='local', intervalSeconds=300)
            ])))
            with patch('sys.argv', ['sync', '--config', str(config)]), patch('catalog_sync.subprocess.run') as run:
                run.return_value = subprocess.CompletedProcess([], 1)
                self.assertEqual(catalog_sync.main(), 1)
                run.return_value = subprocess.CompletedProcess([], 0)
                self.assertEqual(catalog_sync.main(), 0)
                self.assertEqual(run.call_count, 2)
                self.assertEqual(run.call_args.kwargs['env']['BB_SERVER_URL'], 'http://127.0.0.1:1234')
                self.assertEqual(catalog_sync.main(), 0)
                self.assertEqual(run.call_count, 2)
                state = json.loads((Path(directory) / 'last-cycle.json').read_text())
                self.assertIn('local', state['lastSuccess'])


if __name__ == '__main__':
    unittest.main()
