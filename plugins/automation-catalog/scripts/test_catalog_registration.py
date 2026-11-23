import json
from pathlib import Path
import tempfile
import unittest
from catalog_registration import overlay

class RegistryTests(unittest.TestCase):
    def test_overlay_preserves_technical_identity_and_state(self):
        task=dict(id='system:example.timer',host='sample',scheduler='systemd',name='Old',state='paused',description='Observed')
        config=dict(registry=[dict(host='sample',scheduler='systemd',scope='system',unit='example.timer',name='Purpose',owner='operator',stop='original scheduler')])
        with tempfile.TemporaryDirectory() as d:
            file=Path(d)/'registry.json';file.write_text(json.dumps(config))
            overlay([task],file)
        self.assertEqual(task['id'],'system:example.timer')
        self.assertEqual(task['state'],'paused')
        self.assertEqual(task['host'],'sample')
        self.assertTrue(task['name'].startswith('OXI · Purpose'))
        self.assertIn('stop:',task['description'])
