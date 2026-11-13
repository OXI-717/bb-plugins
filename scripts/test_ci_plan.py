import unittest
from ci_plan import PLUGINS, plan


class PlanTests(unittest.TestCase):
    def test_cosmetic_pool_change_keeps_linux_security_and_upgrade(self):
        p = plan(['plugins/account-pool-balanced/app.tsx'])
        self.assertEqual(p['matrix']['include'], [{'os': 'ubuntu-latest', 'plugin': 'account-pool-balanced'}])
        self.assertTrue(p['upgrade'])
        self.assertFalse(p['upgrade_mac'])
        self.assertFalse(p['op'])

    def test_os_bound_changes_require_mac(self):
        for name in ['browser-host.ts', 'host.ts', 'devin-launcher.ts', 'new-platform.ts']:
            with self.subTest(name=name):
                p = plan(['plugins/account-pool-balanced/src/' + name])
                self.assertEqual(len(p['matrix']['include']), 2)
                self.assertTrue(p['upgrade_mac'])

    def test_portable_routing_and_its_tests_keep_critical_linux(self):
        for name in ['balancer.ts', 'balancer.test.ts']:
            p = plan(['plugins/account-pool-balanced/src/' + name])
            self.assertEqual(len(p['matrix']['include']), 1)

    def test_unknown_shared_and_workflow_changes_fail_closed(self):
        for path in ['new-file', 'shared/vpn-evidence.ts', '.github/workflows/ci.yml',
                     'scripts/upgrade_pool.py', 'plugins/new-plugin/file.ts']:
            with self.subTest(path=path):
                p = plan([path])
                self.assertEqual(len(p['matrix']['include']), len(PLUGINS) * 2)
                self.assertTrue(p['upgrade_mac'])
                self.assertTrue(p['op'])

    def test_deleted_old_path_and_renamed_new_path_are_both_considered(self):
        p = plan(['plugins/account-pool-balanced/src/host.ts', 'docs/moved.md'])
        self.assertEqual(len(p['matrix']['include']), 2)

    def test_docs_and_full_mode(self):
        self.assertFalse(plan(['README.md'])['check'])
        self.assertEqual(len(plan([], full=True)['matrix']['include']), 14)

class ReleaseGateTests(unittest.TestCase):
    def test_selected_skips_fail_and_unselected_skips_pass(self):
        from ci_release_gate import validate
        needs = {name: {'result': 'success'} for name in ['plan', 'public-hygiene', 'secrets',
                 'check', 'upgrade-script', 'auto-archive', 'oxi-op']}
        needs['plan']['outputs'] = dict(check='true', upgrade='true', archive='false', op='false')
        needs['auto-archive']['result'] = 'skipped'
        needs['oxi-op']['result'] = 'skipped'
        validate(needs)
        for name in ['plan', 'public-hygiene', 'secrets', 'check', 'upgrade-script']:
            with self.subTest(name=name):
                original = needs[name]['result']
                for bad in ['skipped', 'cancelled', 'failure']:
                    needs[name]['result'] = bad
                    with self.assertRaises(ValueError):
                        validate(needs)
                needs[name]['result'] = original


class WorkflowContractTests(unittest.TestCase):
    def test_full_suite_and_secret_checks_are_preserved(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent
        critical = (root / '.github/workflows/ci.yml').read_text()
        extended = (root / '.github/workflows/ci-extended.yml').read_text()
        self.assertIn('run: npm test', critical)
        self.assertNotIn('testNamePattern', critical)
        self.assertIn('run: npm test', extended)
        self.assertNotIn('  pull_request:', extended)
        for workflow in (critical, extended):
            self.assertIn("--log-opts='--all'", workflow)
            self.assertIn('python3 scripts/check_hygiene.py', workflow)
        self.assertIn('run: python3 scripts/ci_release_gate.py', critical)

class CliTests(unittest.TestCase):
    def test_real_git_diff_includes_deleted_os_code(self):
        import json
        import os
        from pathlib import Path
        import subprocess
        import tempfile
        script = Path(__file__).with_name('ci_plan.py').resolve()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def git(*args):
                result = subprocess.run(['git', *args], cwd=root,
                                        capture_output=True, text=True, timeout=10)
                if result.returncode:
                    raise RuntimeError(result.stderr)
                return result.stdout.strip()
            git('init', '-q')
            # The host's git identity wrapper requires the repo selector even
            # for synthetic local commits. Never commit the selector itself.
            selector = script.parent.parent / '.gh-account'
            (root / '.gitignore').write_text('.gh-account\n')
            if selector.exists():
                (root / '.gh-account').write_bytes(selector.read_bytes())
            path = root / 'plugins/account-pool-balanced/src/browser-host.ts'
            path.parent.mkdir(parents=True)
            path.write_text('// synthetic fixture\n')
            git('add', '.')
            git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid',
                'commit', '-qm', 'fixture base')
            base = git('rev-parse', 'HEAD')
            moved = root / 'docs/moved.md'
            moved.parent.mkdir()
            path.rename(moved)
            git('add', '-A')
            git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid',
                'commit', '-qm', 'fixture move')
            output = root / 'output'
            subprocess.run(['python3', str(script)], cwd=root, check=True, timeout=10,
                           env={**os.environ, 'EVENT_NAME': 'pull_request',
                                'DIFF_BASE': base, 'DIFF_HEAD': 'HEAD', 'GITHUB_OUTPUT': str(output)})
            fields = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertTrue(json.loads(fields['upgrade_mac']))
            self.assertEqual(len(json.loads(fields['matrix'])['include']), 2)
            git('tag', 'account-pool-balanced/v0.0.1', base)
            git('tag', 'account-pool-balanced/v0.0.2')
            output.write_text('')
            subprocess.run(['python3', str(script)], cwd=root, check=True, timeout=10,
                           env={**os.environ, 'EVENT_NAME': 'push',
                                'GIT_REF': 'refs/tags/account-pool-balanced/v0.0.2',
                                'DIFF_HEAD': 'HEAD', 'GITHUB_OUTPUT': str(output)})
            fields = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertEqual(len(json.loads(fields['matrix'])['include']), 2)

            output.write_text('')
            subprocess.run(['python3', str(script)], cwd=root, check=True, timeout=10,
                           env={**os.environ, 'EVENT_NAME': 'push',
                                'GIT_REF': 'refs/heads/main', 'DIFF_HEAD': 'HEAD',
                                'GITHUB_OUTPUT': str(output)})
            fields = dict(line.split('=', 1) for line in output.read_text().splitlines())
            self.assertEqual(len(json.loads(fields['matrix'])['include']), 14)


class CoverageTests(unittest.TestCase):
    def test_existing_and_new_test_paths_are_required(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent
        plugin = root / 'plugins/account-pool-balanced'
        config = (plugin / 'vitest.config.ts').read_text()
        patterns = ['src/**/*.test.ts', 'src/**/*.test.tsx', '*.test.ts', '*.test.tsx']
        for pattern in patterns:
            self.assertIn('"' + pattern + '"', config)
        # The old named root UI files and every existing source test remain covered.
        tests = list(plugin.glob('*.test.tsx')) + list((plugin / 'src').rglob('*.test.ts'))
        self.assertGreater(len(tests), 75)
        self.assertNotIn('testNamePattern', config)
        self.assertNotIn('exclude:', config)


class TriggerOverlapTests(unittest.TestCase):
    def test_main_full_ci_does_not_also_trigger_extended(self):
        from pathlib import Path
        root = Path(__file__).resolve().parent.parent
        critical = (root / '.github/workflows/ci.yml').read_text()
        extended = (root / '.github/workflows/ci-extended.yml').read_text()
        self.assertIn('branches: [main]', critical)
        self.assertIn('branches: [release/account-pool-0.4.x]', extended)
        self.assertNotIn('branches: [main', extended)
        # Normal non-PR builds retain all required platform/plugin checks.
        full = plan([], full=True)
        self.assertEqual(len(full['matrix']['include']), 14)
        self.assertTrue(full['upgrade_mac'])
        self.assertTrue(full['op'])
        self.assertTrue(full['archive'])


if __name__ == '__main__':
    unittest.main()
