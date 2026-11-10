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

    def test_no_matching_release_fails_without_branch_fallback(self):
        row={'git_resolved_commit':'abc','id':'example','version':'0.4.0','source_git_url':'https://example.invalid/repo.git','source_git_subdirectory':None}
        with patch('plugin_tracking.remote',return_value='abc\trefs/tags/v0.3.0\n'):
            with self.assertRaisesRegex(RuntimeError, 'verified release tag'):
                plan(row)

    def test_missing_default_fails(self):
        with patch('plugin_tracking.remote',return_value=''):
            with self.assertRaises(RuntimeError):
                plan({'git_resolved_commit':'abc','id':'example','version':'0.1.0','source_git_url':'https://example.invalid/repo.git','source_git_subdirectory':None})


class SafetyTests(unittest.TestCase):
    def row(self):
        return {'git_resolved_commit':'abc','id':'example','version':'0.2.4',
                'source_git_url':'https://example.invalid/repo.git',
                'source_git_subdirectory':'plugins/example'}

    def test_foreign_and_root_tags_rejected_for_monorepo(self):
        for tag in ['other/v0.2.4', 'v0.2.4']:
            with self.subTest(tag=tag), patch('plugin_tracking.remote',return_value=f'abc\trefs/tags/{tag}\n'):
                with self.assertRaises(RuntimeError): plan(self.row())

    def test_credential_url_rejected_before_git(self):
        for url in ['https://user:EXAMPLE_SECRET@example.invalid/repo.git',
                    'https://example.invalid/repo.git?token=EXAMPLE_SECRET',
                    'https://example.invalid/repo.git#EXAMPLE_SECRET']:
            row=self.row();row['source_git_url']=url
            with patch('plugin_tracking.remote') as remote:
                with self.assertRaises(RuntimeError) as caught: plan(row)
                self.assertNotIn('EXAMPLE_SECRET', str(caught.exception));remote.assert_not_called()

    def test_annotated_tag_and_wrong_commit(self):
        with patch('plugin_tracking.remote',return_value='tagsha\trefs/tags/example/v0.2.4\nabc\trefs/tags/example/v0.2.4^{}\n'):
            self.assertEqual(plan(self.row())['source_git_resolved_tag'],'example/v0.2.4')
        with patch('plugin_tracking.remote',return_value='other\trefs/tags/example/v0.2.4\n'):
            with self.assertRaises(RuntimeError):plan(self.row())

    def test_transaction_preserves_state_and_rolls_back(self):
        import sqlite3
        from plugin_tracking import FIELDS, apply_changes
        db=sqlite3.connect(':memory:');db.row_factory=sqlite3.Row
        db.execute('CREATE TABLE plugins (id TEXT PRIMARY KEY,'+','.join(k+' TEXT' for k in FIELDS)+', enabled INTEGER, settings TEXT)')
        db.execute('CREATE TABLE plugin_kv (value TEXT)');db.execute("INSERT INTO plugin_kv VALUES ('unchanged')")
        for id in ['one','two']:
            db.execute('INSERT INTO plugins VALUES (?,?,?,?,?,?,?,?,?)',(id,'old','sha','commit',None,None,None,0,'fixture'))
        db.commit()
        rows=[dict(r) for r in db.execute('SELECT * FROM plugins ORDER BY id')]
        changes=[(r,dict(zip(FIELDS,['new',None,None,'^0.2.4','example/','example/v0.2.4']))) for r in rows]
        db.execute("UPDATE plugins SET settings='concurrent' WHERE id='two'");db.commit()
        with self.assertRaisesRegex(RuntimeError,'concurrently'):apply_changes(db,changes)
        self.assertEqual(db.execute("SELECT source FROM plugins WHERE id='one'").fetchone()[0],'old')
        self.assertEqual(db.execute("SELECT settings FROM plugins WHERE id='two'").fetchone()[0],'concurrent')
        apply_changes(db,changes[:1])
        after=dict(db.execute("SELECT * FROM plugins WHERE id='one'").fetchone())
        self.assertEqual(after,{**rows[0],**changes[0][1]})
        self.assertEqual(db.execute('SELECT value FROM plugin_kv').fetchone()[0],'unchanged')
        db.close()

if __name__=='__main__': unittest.main()
