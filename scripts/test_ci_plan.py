import ast
import json
import os
from pathlib import Path
import re
import sys
import unittest
from ci_plan import CURSOR_TEST, CURSOR_WRAPPER, OP_POOL_MODULES, PLUGINS, POOL, plan


def active_rows(result):
    return [{k: row[k] for k in ('os', 'plugin')}
            for row in result['matrix']['include'] if row['run']]


class PlanTests(unittest.TestCase):
    def test_cursor_suite_is_independent_of_upgrade_rehearsal(self):
        self.assertFalse(plan(['plugins/account-pool-balanced/app.tsx']).get('cursor'))
        for path in ('scripts/test_cursor_route.py',
                     'plugins/account-pool-balanced/scripts/cursor-route.py'):
            with self.subTest(path=path):
                result = plan([path])
                self.assertTrue(result.get('cursor'))
                self.assertFalse(result['upgrade'])

    def test_cursor_input_contract(self):
        root = Path(__file__).resolve().parent.parent
        test = ast.parse((root / CURSOR_TEST).read_text())
        wrapper = next(node.value for node in test.body if isinstance(node, ast.Assign)
                       and any(isinstance(target, ast.Name) and target.id == 'WRAPPER'
                               for target in node.targets))
        self.assertIsInstance(wrapper.op, ast.Div)
        self.assertEqual(wrapper.right.value, CURSOR_WRAPPER)
        for path in (CURSOR_TEST, CURSOR_WRAPPER,
                     'plugins/account-pool-balanced/scripts/cursor-helper.py',
                     'plugins/account-pool-balanced/scripts/new-local-helper.py'):
            self.assertTrue(plan([path])['cursor'], path)
        for path in (CURSOR_TEST, CURSOR_WRAPPER):
            # The gateway subprocess and its harness currently use only stdlib
            # plus this explicit dynamic import of the wrapper.
            tree = ast.parse((root / path).read_text())
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    for alias in node.names:
                        self.assertIn(alias.name.split('.')[0], sys.stdlib_module_names, path)
                if isinstance(node, ast.ImportFrom):
                    self.assertEqual(node.level, 0, path)
                    self.assertIn(node.module.split('.')[0], sys.stdlib_module_names, path)

    def test_pool_typescript_uses_the_package_suite_for_cursor_wire_coverage(self):
        for path in ('src/server.ts', 'src/standalone/runtime.ts', 'src/cursor-adapter.ts'):
            with self.subTest(path=path):
                result = plan([POOL + path])
                self.assertFalse(result['cursor'])
                self.assertEqual(active_rows(result), [
                    {'os': 'ubuntu-latest', 'plugin': 'account-pool-balanced'},
                    {'os': 'macos-latest', 'plugin': 'account-pool-balanced'},
                ])

    def test_quota_pr_does_not_run_the_python_gateway_or_session_tree(self):
        paths = ['app.tsx', 'app.test.tsx', 'src/server.ts', 'src/balancer.ts', 'src/quota.ts',
                 'src/account-policy.ts', 'src/contracts.ts', 'src/hub.ts']
        result = plan([POOL + path for path in paths])
        self.assertFalse(result['cursor'])
        self.assertFalse(result['session_tree'])
        self.assertTrue(result['op'])  # The native-task fixture imports contracts.ts.
        self.assertTrue(result['upgrade'])
        self.assertEqual(len(active_rows(result)), 2)

    def test_session_tree_depends_on_its_plugin_or_unknown_shared_inputs(self):
        for path in ('plugins/oxi-thread-list/app.tsx', 'shared/new-helper.ts', '.github/workflows/ci.yml'):
            with self.subTest(path=path):
                self.assertTrue(plan([path])['session_tree'])
        for path in ('README.md', POOL + 'src/server.ts', POOL + 'app.tsx'):
            with self.subTest(path=path):
                self.assertFalse(plan([path])['session_tree'])
        self.assertEqual(active_rows(plan(['plugins/oxi-thread-list/app.tsx'])), [])
        self.assertTrue(plan([], full=True)['session_tree'])

    def test_cursor_does_not_follow_independent_jobs(self):
        for path in ['scripts/upgrade_pool.py', 'plugins/automation-catalog/app.tsx',
                     'plugins/oxi-op/server.ts', 'plugins/oxi-thread-list/app.tsx',
                     POOL + 'scripts/claude-host-doctor.py', POOL + 'scripts/test_claude_host_doctor.py']:
            with self.subTest(path=path):
                self.assertFalse(plan([path])['cursor'])

    def test_cosmetic_pool_change_keeps_package_check_without_upgrade_rehearsal(self):
        p = plan(['plugins/account-pool-balanced/app.tsx'])
        self.assertEqual(active_rows(p), [{'os': 'ubuntu-latest', 'plugin': 'account-pool-balanced'}])
        self.assertFalse(p['upgrade'])
        self.assertFalse(p['upgrade_mac'])
        self.assertFalse(p['op'])

    def test_upgrade_rehearsal_keeps_installer_backend_and_release_inputs(self):
        for path in (POOL + 'pool-update-panel.tsx', POOL + 'package.json',
                     POOL + 'src/cli.ts', 'scripts/upgrade_pool.py'):
            with self.subTest(path=path):
                self.assertTrue(plan([path])['upgrade'])
        release = plan([POOL + 'package.json'], version_plugin='account-pool-balanced',
                       version_paths={POOL + 'package.json'})
        self.assertTrue(release['upgrade'])

    def test_pool_settings_regression_tests_run_on_macos(self):
        p = plan(['plugins/account-pool-balanced/app.test.tsx'])
        self.assertEqual(active_rows(p), [
            {'os': 'ubuntu-latest', 'plugin': 'account-pool-balanced'},
            {'os': 'macos-latest', 'plugin': 'account-pool-balanced'},
        ])

    def test_os_bound_changes_require_mac(self):
        for name in ['browser-host.ts', 'host.ts', 'devin-launcher.ts', 'new-platform.ts']:
            with self.subTest(name=name):
                p = plan(['plugins/account-pool-balanced/src/' + name])
                self.assertEqual(len(active_rows(p)), 2)
                self.assertTrue(p['upgrade_mac'])

    def test_portable_routing_and_its_tests_keep_critical_linux(self):
        for name in ['balancer.ts', 'balancer.test.ts']:
            p = plan(['plugins/account-pool-balanced/src/' + name])
            self.assertEqual(len(active_rows(p)), 1)

    def test_portable_pool_server_change_runs_linux_rehearsal_and_keeps_mac_context(self):
        result = plan([POOL + 'src/hub.ts', POOL + 'src/server.test.ts'])
        self.assertEqual(active_rows(result), [
            {'os': 'ubuntu-latest', 'plugin': 'account-pool-balanced'},
        ])
        self.assertIn({'os': 'macos-latest', 'plugin': 'account-pool-balanced', 'run': False},
                      result['matrix']['include'])
        self.assertTrue(result['upgrade'])
        self.assertFalse(result['upgrade_mac'])
        self.assertFalse(result['cursor'])

    def test_op_pool_dependencies_require_cross_plugin_integration(self):
        root = Path(__file__).resolve().parent.parent
        fixture = (root / 'plugins/oxi-op/test/native-task-host.mjs').read_text()
        match = re.search(r'for\(const name of (\[[^\]]+\])\)', fixture)
        self.assertIsNotNone(match, 'Keep the OP fixture dependency contract explicit')
        modules = ast.literal_eval(match.group(1))
        self.assertEqual(set(modules), OP_POOL_MODULES)
        for module in modules:
            with self.subTest(module=module):
                p = plan(['plugins/account-pool-balanced/src/' + module + '.ts'])
                self.assertTrue(p['op'], 'Pooler dependency must run OP integration tests')
                self.assertEqual(len(active_rows(p)), 1 if module == 'project-policy' else 2)
                self.assertEqual(p['upgrade_mac'], module != 'project-policy')
        self.assertFalse(plan(['plugins/account-pool-balanced/src/balancer.ts'])['op'])

    def test_unknown_shared_and_workflow_changes_fail_closed(self):
        for path in ['new-file', 'shared/vpn-evidence.ts', '.github/workflows/ci.yml',
                     'scripts/upgrade_pool.py', 'plugins/new-plugin/file.ts']:
            with self.subTest(path=path):
                p = plan([path])
                self.assertEqual(len(active_rows(p)), len(PLUGINS) * 2)
                self.assertTrue(p['upgrade_mac'])
                self.assertTrue(p['op'])
                self.assertEqual(p['cursor'], path != 'scripts/upgrade_pool.py')

    def test_deleted_old_path_and_renamed_new_path_are_both_considered(self):
        p = plan(['plugins/account-pool-balanced/src/host.ts', 'docs/moved.md'])
        self.assertEqual(len(active_rows(p)), 2)

    def test_docs_and_full_mode(self):
        self.assertEqual(active_rows(plan(['README.md'])), [])
        self.assertEqual(len(plan([], full=True)['matrix']['include']), 14)

class RequiredContextTests(unittest.TestCase):
    def test_required_contexts_exist_without_running_unaffected_plugins(self):
        required = {(os, plugin) for os in ['ubuntu-latest', 'macos-latest']
                    for plugin in ['account-pool-balanced', 'automation-catalog']}
        for paths, active in [
            (['plugins/account-pool-balanced/src/browser-host.ts'],
             {pair for pair in required if pair[1] == 'account-pool-balanced'}),
            (['plugins/automation-catalog/src/server.ts'],
             {pair for pair in required if pair[1] == 'automation-catalog'}),
            (['README.md'], set()),
        ]:
            with self.subTest(paths=paths):
                result = plan(paths)
                rows = result['matrix']['include']
                self.assertTrue(result['check'])
                self.assertEqual({(r['os'], r['plugin']) for r in rows}, required)
                self.assertEqual({(r['os'], r['plugin']) for r in rows if r['run']}, active)
                self.assertEqual(len(rows), 4)

    def test_full_runs_every_row(self):
        rows = plan([], full=True)['matrix']['include']
        self.assertEqual(len(rows), len(PLUGINS) * 2)
        self.assertTrue(all(row['run'] for row in rows))

    def test_workflow_names_and_step_gates(self):
        workflow = (Path(__file__).resolve().parent.parent / '.github/workflows/ci.yml').read_text()
        job = workflow.split('\n  check:\n')[1].split('\n  session-tree:')[0]
        self.assertIn('name: check (${{ matrix.os }}, ${{ matrix.plugin }})', job)
        self.assertIn("runs-on: ${{ matrix.run && matrix.os || 'ubuntu-latest' }}", job)
        self.assertNotIn('    if:', job.split('    strategy:')[0])
        # Every expensive step, including checkout/setup, must be conditional.
        for step in job.split('      - ')[1:]:
            self.assertIn('if: matrix.run', step)


class ReleaseGateTests(unittest.TestCase):
    def test_selected_skips_fail_and_unselected_skips_pass(self):
        from ci_release_gate import validate
        needs = {name: {'result': 'success'} for name in ['plan', 'public-hygiene', 'secrets', 'session-tree',
                 'check', 'upgrade-script', 'auto-archive', 'oxi-op', 'cursor-gateway']}
        needs['plan']['outputs'] = dict(check='true', upgrade='true', archive='false', op='false', cursor='true')
        needs['auto-archive']['result'] = 'skipped'
        needs['oxi-op']['result'] = 'skipped'
        validate(needs)
        for name in ['plan', 'public-hygiene', 'secrets', 'session-tree', 'check', 'upgrade-script', 'cursor-gateway']:
            with self.subTest(name=name):
                original = needs[name]['result']
                for bad in ['skipped', 'cancelled', 'failure']:
                    needs[name]['result'] = bad
                    with self.assertRaises(ValueError):
                        validate(needs)
                needs[name]['result'] = original
        needs['plan']['outputs']['cursor'] = 'false'
        needs['cursor-gateway']['result'] = 'skipped'
        validate(needs)
        needs['plan']['outputs']['cursor'] = 'invalid'
        with self.assertRaises(ValueError):
            validate(needs)
        del needs['plan']['outputs']['cursor']
        with self.assertRaises(KeyError):
            validate(needs)


class WorkflowContractTests(unittest.TestCase):
    def test_full_suite_and_secret_checks_are_preserved(self):
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
        for workflow in (critical, extended):
            self.assertNotIn('  schedule:', workflow)
            self.assertIn('  workflow_dispatch:', workflow)
            matching_job = workflow.split('\n  cursor-gateway:\n')[1].split('\n  secrets:')[0]
            self.assertIn('os: [ubuntu-latest, macos-latest]', matching_job)
            self.assertGreaterEqual(int(re.search(r'timeout-minutes: (\d+)', matching_job)[1]), 12)
            self.assertIn('unittest discover -s scripts -p test_cursor_route.py', matching_job)
            self.assertEqual(workflow.count('test_cursor_route.py'), 1)
        self.assertIn("if: needs.plan.outputs.cursor == 'true'", critical)
        self.assertIn('steps.select.outputs.cursor', critical)
        self.assertIn('release-gate:\n    if: always()', critical)
        self.assertIn('session-tree, cursor-gateway]', critical)
        self.assertNotIn('    if:', extended.split('\n  cursor-gateway:\n')[1].split('\n  secrets:')[0])

    def test_projects_suite_and_repository_checks_run_once_per_scope(self):
        root = Path(__file__).resolve().parent.parent
        for workflow_path in ('.github/workflows/ci.yml', '.github/workflows/ci-extended.yml'):
            workflow = (root / workflow_path).read_text()
            with self.subTest(workflow=workflow_path):
                self.assertEqual(workflow.count('node scripts/check-manifests.mjs'), 1)
                self.assertEqual(workflow.count('node scripts/check-vpn-contract.mjs'), 1)
                matrix = re.split(r'\n  (?:session-tree|upgrade-script):', workflow.split('\n  check:\n')[1], maxsplit=1)[0]
                self.assertEqual(matrix.count('run: npx vitest run'), 1)
                self.assertEqual(matrix.count('run: npm test'), 1)
                hygiene = workflow.split('\n  public-hygiene:\n')[1].split('\n  check:')[0]
                self.assertIn('node scripts/check-manifests.mjs', hygiene)
                self.assertIn('node scripts/check-vpn-contract.mjs', hygiene)
                projects = json.loads((root / 'plugins/oxi-projects/package.json').read_text())
                self.assertIn('test/*.test.ts', projects['scripts']['test'])
                self.assertIn("'test/**'", (root / 'plugins/oxi-projects/vitest.config.ts').read_text())

    def test_session_tree_keeps_its_context_and_gates_expensive_steps(self):
        root = Path(__file__).resolve().parent.parent
        workflow = (root / '.github/workflows/ci.yml').read_text()
        job = workflow.split('\n  session-tree:\n')[1].split('\n  upgrade-script:')[0]
        before_steps, steps = job.split('    steps:\n')
        self.assertIn('needs: plan', before_steps)
        self.assertNotIn('    if:', before_steps)
        active, placeholder = steps.split('      - name: Report unchanged Session Tree')
        for step in active.split('      - ')[1:]:
            self.assertIn("if: needs.plan.outputs.session_tree == 'true'", step)
        self.assertIn("if: needs.plan.outputs.session_tree != 'true'", placeholder)
        self.assertIn('run: test "$SELECTED" = false', placeholder)

    def test_documented_ownership_matches_inventory_and_jobs(self):
        root = Path(__file__).resolve().parent.parent
        docs = (root / 'docs/ci-selection.md').read_text()
        inventory = {p.parent.name for p in (root / 'plugins').glob('*/package.json')}
        market = {p['id'] for p in json.loads((root / 'marketplace.json').read_text())['plugins']}
        rows = re.findall(r'^\| `([a-z-]+)` \| `([a-z-]+)`', docs, re.MULTILINE)
        self.assertEqual(len(rows), len(inventory))
        expected = {plugin: 'check' for plugin in PLUGINS}
        expected.update({'oxi-thread-list': 'session-tree', 'oxi-op': 'oxi-op', 'auto-archive': 'auto-archive'})
        self.assertEqual(set(expected), inventory)
        self.assertEqual(set(expected), market)
        self.assertEqual(dict(rows), expected)
        extended = (root / '.github/workflows/ci-extended.yml').read_text()
        matrix = re.search(r'^        plugin: \[([^\]]+)\]', extended, re.MULTILINE)
        self.assertEqual(set(matrix[1].split(', ')), set(PLUGINS))

class CliTests(unittest.TestCase):
    def test_real_git_diff_includes_deleted_os_code(self):
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

            def event(name, ref='', before='', pr_base=base):
                output.write_text('')
                subprocess.run(['python3', str(script)], cwd=root, check=True, timeout=10,
                               env={**os.environ, 'EVENT_NAME': name, 'GIT_REF': ref,
                                    'PUSH_BEFORE': before, 'DIFF_BASE': pr_base,
                                    'DIFF_HEAD': 'HEAD', 'GITHUB_OUTPUT': str(output)})
                return {key: json.loads(value) for key, value in
                        (line.split('=', 1) for line in output.read_text().splitlines())}

            result = event('pull_request')
            self.assertTrue(result['upgrade_mac'])
            self.assertFalse(result['cursor'])
            self.assertEqual(len(active_rows(result)), 2)
            self.assertEqual(len(result['matrix']['include']), 4)
            git('tag', 'account-pool-balanced/v0.0.1', base)
            git('tag', 'account-pool-balanced/v0.0.2')
            result = event('push', 'refs/tags/account-pool-balanced/v0.0.2')
            self.assertEqual(len(active_rows(result)), 2)
            self.assertEqual(len(result['matrix']['include']), 4)

            main = 'refs/heads/main'
            self.assertFalse(event('push', main, base)['cursor'])
            result = event('push', main, '0' * 40)
            self.assertEqual(len(active_rows(result)), 14)
            self.assertTrue(result['cursor'])
            self.assertTrue(event('workflow_dispatch', main, base)['cursor'])

            before = git('rev-parse', 'HEAD')
            hub = root / POOL / 'src/hub.ts'
            hub.write_text('// portable server behavior\n')
            git('add', str(hub))
            git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid',
                'commit', '-qm', 'fixture portable pool')
            result = event('push', main, before)
            self.assertEqual(active_rows(result), [
                {'os': 'ubuntu-latest', 'plugin': 'account-pool-balanced'},
            ])
            self.assertTrue(result['upgrade'])
            self.assertFalse(result['upgrade_mac'])
            self.assertFalse(result['cursor'])
            git('tag', 'account-pool-balanced/v0.0.3')
            self.assertEqual(event('push', 'refs/tags/account-pool-balanced/v0.0.3'), result)

            before = git('rev-parse', 'HEAD')
            git('tag', 'automation-catalog/v0.0.1')
            self.assertTrue(event('push', 'refs/tags/automation-catalog/v0.0.1')['cursor'])

            cursor_test = root / CURSOR_TEST
            cursor_test.parent.mkdir()
            cursor_test.write_text('# synthetic gateway test change\n')
            git('add', CURSOR_TEST)
            git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid',
                'commit', '-qm', 'fixture cursor test')
            self.assertTrue(event('pull_request', pr_base=before)['cursor'])
            self.assertTrue(event('push', main, before)['cursor'])
            git('tag', 'automation-catalog/v0.0.2')
            self.assertTrue(event('push', 'refs/tags/automation-catalog/v0.0.2')['cursor'])

            catalog = root / 'plugins/automation-catalog/server.ts'
            catalog.parent.mkdir()
            catalog.write_text('// unrelated release change\n')
            git('add', str(catalog))
            git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid',
                'commit', '-qm', 'fixture catalog')
            git('tag', 'automation-catalog/v0.0.3')
            # A newer version pointing at an old ancestor cannot be the baseline.
            git('tag', 'automation-catalog/v0.0.5', base)
            self.assertFalse(event('push', 'refs/tags/automation-catalog/v0.0.3')['cursor'])


class CoverageTests(unittest.TestCase):
    def test_existing_and_new_test_paths_are_required(self):
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
    def test_main_ci_does_not_also_trigger_extended(self):
        root = Path(__file__).resolve().parent.parent
        critical = (root / '.github/workflows/ci.yml').read_text()
        extended = (root / '.github/workflows/ci-extended.yml').read_text()
        self.assertIn('branches: [main]', critical)
        self.assertIn('branches: [release/account-pool-0.4.x]', extended)
        self.assertNotIn('branches: [main', extended)
        # Manual and fallback plans retain all required platform/plugin checks.
        full = plan([], full=True)
        self.assertEqual(len(full['matrix']['include']), 14)
        self.assertTrue(full['upgrade_mac'])
        self.assertTrue(full['op'])
        self.assertTrue(full['archive'])


if __name__ == '__main__':
    unittest.main()
