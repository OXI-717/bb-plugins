import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class ProtectionUpgradeTests(unittest.TestCase):
    def test_wait_idle_is_delegated_without_guard_calls(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            (root/'bb').write_text('#!/bin/sh\necho bb >> "$CALLS"\nexit 99\n')
            (root/'python3').write_text('#!/bin/sh\necho "$*" >> "$CALLS"\nexit 0\n')
            for name in ['bb','python3']:(root/name).chmod(0o700)
            env={**os.environ,'PATH':str(root)+os.pathsep+os.environ['PATH'],'CALLS':str(root/'calls')}
            result=subprocess.run(['bash',str(Path(__file__).with_name('upgrade-protection.sh')),'--wait-idle'],env=env,capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0)
            calls=(root/'calls').read_text()
            self.assertIn('upgrade_pool.py --wait-idle',calls)
            self.assertNotIn('bb',calls.splitlines())

    def test_busy_pool_never_updates_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'bb').write_text('''#!/bin/sh
echo "$*" >> "$CALLS"
case "$*" in
  "vpn-guard status --json") echo '{"mode":"observe","manualBlock":false,"suspendNativePluginsGlobally":false,"ownedDisabledPlugins":[],"ambiguousPluginChanges":[]}' ;;
  *) exit 99 ;;
esac
''')
            (root / 'python3').write_text('''#!/bin/sh
case "$1" in
  *upgrade_pool.py) echo "$*" >> "$CALLS"; exit 1 ;;
  *) exec "$REAL_PYTHON" "$@" ;;
esac
''')
            for name in ['bb', 'python3']:
                (root / name).chmod(0o700)
            import sys
            env = {**os.environ, 'PATH': str(root) + os.pathsep + os.environ['PATH'],
                   'CALLS': str(root / 'calls'), 'REAL_PYTHON': sys.executable}
            script = Path(__file__).with_name('upgrade-protection.sh')
            result = subprocess.run(['bash', str(script)], env=env, capture_output=True, text=True, timeout=10)
            calls = (root / 'calls').read_text()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('--wait-idle', calls)
            self.assertNotIn('plugin update', calls)


if __name__ == '__main__':
    unittest.main()
