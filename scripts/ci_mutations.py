"""Run a small set of deterministic CI and Cursor regression mutations."""
from dataclasses import dataclass
from importlib import import_module
import io
from pathlib import Path
import sys
from types import ModuleType
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
PLANNER = 'scripts/ci_plan.py'
GATE = 'scripts/ci_release_gate.py'
WORKFLOW = '.github/workflows/ci.yml'
WRAPPER = 'plugins/account-pool-balanced/scripts/cursor-route.py'


@dataclass(frozen=True)
class Mutation:
    name: str
    path: str
    original: str
    replacement: str
    test: str


MUTATIONS = (
    Mutation('unrelated Pool server edits run Cursor', PLANNER,
             "if path == CURSOR_TEST:\n            return True",
             "if path == CURSOR_TEST or path == POOL + 'src/server.ts':\n            return True",
             'test_ci_plan.PlanTests.test_quota_pr_does_not_run_the_python_gateway_or_session_tree'),
    Mutation('Cursor launcher edits lose the gateway suite', PLANNER,
             'and path not in CURSOR_UNRELATED_PYTHON):',
             'and path not in CURSOR_UNRELATED_PYTHON and path != CURSOR_WRAPPER):',
             'test_ci_plan.PlanTests.test_cursor_suite_is_independent_of_upgrade_rehearsal'),
    Mutation('unknown shared inputs lose the gateway suite', PLANNER,
             "if len(parts) > 2 and parts[0] == 'plugins' and parts[1] in KNOWN_PLUGINS:\n            continue\n        return True",
             "if len(parts) > 2 and parts[0] == 'plugins' and parts[1] in KNOWN_PLUGINS:\n            continue\n        return False",
             'test_ci_plan.PlanTests.test_unknown_shared_and_workflow_changes_fail_closed'),
    Mutation('cosmetic changes rehearse upgrade again', PLANNER,
             "if path != CURSOR_WRAPPER and (not path.endswith(('.css', '.tsx')) or path == POOL + 'pool-update-panel.tsx'):",
             'if path != CURSOR_WRAPPER:',
             'test_ci_plan.PlanTests.test_cosmetic_pool_change_keeps_package_check_without_upgrade_rehearsal'),
    Mutation('Pool release drops the upgrade rehearsal', PLANNER,
             "upgrade |= version_plugin == 'account-pool-balanced'", 'upgrade |= False',
             'test_ci_plan.PlanTests.test_upgrade_rehearsal_keeps_installer_backend_and_release_inputs'),
    Mutation('Session Tree edits lose their package checks', PLANNER,
             "elif path.startswith('plugins/oxi-thread-list/'):\n            session_tree = True",
             "elif path.startswith('plugins/oxi-thread-list/'):\n            session_tree = False",
             'test_ci_plan.PlanTests.test_session_tree_depends_on_its_plugin_or_unknown_shared_inputs'),
    Mutation('selected jobs may skip the release gate', GATE,
             "allowed = ('success',) if value == 'true' else ('success', 'skipped')",
             "allowed = ('success', 'skipped')",
             'test_ci_plan.ReleaseGateTests.test_selected_skips_fail_and_unselected_skips_pass'),
    Mutation('Projects loses its separate UI tests', WORKFLOW,
             '        run: npx vitest run\n', '        run: echo removed\n',
             'test_ci_plan.WorkflowContractTests.test_projects_suite_and_repository_checks_run_once_per_scope'),
    Mutation('Projects loses its Node tests', WORKFLOW,
             '        run: npm test\n      - name: Project UI and integration tests',
             '        run: echo removed\n      - name: Project UI and integration tests',
             'test_ci_plan.WorkflowContractTests.test_projects_suite_and_repository_checks_run_once_per_scope'),
    Mutation('Cursor dispatch loses the pool endpoint', WRAPPER,
             'return [executable, *passthrough, "--agent-endpoint", endpoint]',
             'return [executable, *passthrough]',
             'test_cursor_route.CursorRouteTest.test_explicit_endpoint_cannot_bypass_pool'),
    Mutation('pooled Cursor uses the persistent credential store', WRAPPER,
             'result["AGENT_CLI_CREDENTIAL_STORE"] = "memory"',
             'result["AGENT_CLI_CREDENTIAL_STORE"] = "system"',
             'test_cursor_route.CursorRouteTest.test_custom_config_still_keeps_pooled_auth_in_memory'),
)


def run_test(test, source_path=None, source=None):
    module_name, test_name = test.split('.', 1)
    read_text = Path.read_text

    def read_source(path, *args, **kwargs):
        return source if path.resolve() == source_path else read_text(path, *args, **kwargs)

    with patch.dict(sys.modules), patch.object(Path, 'read_text', read_source):
        sys.modules.pop(module_name, None)
        modified = None
        if source_path is not None and source_path.suffix == '.py':
            modified = ModuleType(source_path.stem)
            modified.__file__ = str(source_path)
            exec(compile(source, str(source_path), 'exec'), modified.__dict__)
            sys.modules[modified.__name__] = modified
        tests = import_module(module_name)
        if source_path == ROOT / WRAPPER:
            tests.route = modified
        suite = unittest.defaultTestLoader.loadTestsFromName(test_name, tests)
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output).run(suite)
        return result, output.getvalue()


def main():
    failed = []
    for mutation in MUTATIONS:
        source_path = ROOT / mutation.path
        source = source_path.read_text()
        if source.count(mutation.original) != 1:
            failed.append(f'{mutation.name}: mutation anchor must occur once')
            continue
        clean, report = run_test(mutation.test)
        if not clean.wasSuccessful() or clean.testsRun != 1 or clean.skipped:
            failed.append(f'{mutation.name}: baseline failed or was skipped\n{report}')
            continue
        mutated, report = run_test(mutation.test, source_path,
                                   source.replace(mutation.original, mutation.replacement, 1))
        if mutated.testsRun != 1 or mutated.errors or not mutated.failures:
            failed.append(f'{mutation.name}: expected an assertion failure\n{report}')
            continue
        print(f'DETECTED {mutation.name}')
    for failure in failed:
        print(f'FAIL {failure}', file=sys.stderr)
    print(f'{len(MUTATIONS) - len(failed)}/{len(MUTATIONS)} mutations detected')
    return bool(failed)


if __name__ == '__main__':
    sys.exit(main())
