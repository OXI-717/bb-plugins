import unittest
from unittest.mock import patch
from plugin_tracking import plan

class TrackingTests(unittest.TestCase):
    def test_release_range(self):
        row={'git_resolved_commit':'abc','id':'example','version':'0.2.4','source_git_url':'https://example.invalid/repo.git','source_git_subdirectory':'plugins/example'}
        with patch('plugin_tracking.remote',return_value='abc\trefs/tags/example/v0.2.4\n'):
            value=plan(row)
        self.assertEqual(value['source_git_range'],'^0.2.4')
        self.assertEqual(value['source_git_tag_prefix'],'example/')
        self.assertIsNone(value['source_git_requested_ref'])

    def test_no_matching_release_uses_verified_default(self):
        row={'git_resolved_commit':'abc','id':'example','version':'0.4.0','source_git_url':'https://example.invalid/repo.git','source_git_subdirectory':None}
        with patch('plugin_tracking.remote',side_effect=['abc\trefs/tags/v0.3.0\n','ref: refs/heads/stable\tHEAD\n']):
            value=plan(row)
        self.assertEqual(value['source_git_requested_ref'],'stable')
        self.assertEqual(value['source_git_ref_kind'],'branch')
        self.assertIsNone(value['source_git_range'])

    def test_missing_default_fails(self):
        with patch('plugin_tracking.remote',return_value=''):
            with self.assertRaises(RuntimeError):
                plan({'git_resolved_commit':'abc','id':'example','version':'0.1.0','source_git_url':'https://example.invalid/repo.git','source_git_subdirectory':None})

if __name__=='__main__': unittest.main()
