import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('native_config', Path(__file__).with_name('agy-native-oauth-config.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NativeDefaultsTest(unittest.TestCase):
    def make(self, root, source):
        path = Path(root) / 'native.par'
        with zipfile.ZipFile(path, 'w') as package:
            package.writestr(module.MEMBER, source)
        path.chmod(0o600)
        return path

    def test_only_distributed_defaults_are_read_without_executing_source(self):
        with tempfile.TemporaryDirectory() as root:
            source = "_DEFAULT_CLIENT_ID='synthetic.apps.googleusercontent.com'\n_DEFAULT_CLIENT_SECRET='synthetic-app-secret'\n_DEFAULT_SCOPES=['openid','https://www.googleapis.com/auth/userinfo.email']\nraise RuntimeError('must not execute')\n"
            path = self.make(root, source)
            self.assertEqual(module.read_defaults(path)['clientId'], 'synthetic.apps.googleusercontent.com')
            link = Path(root) / 'link.par'
            link.symlink_to(path)
            with self.assertRaises(OSError):
                module.read_defaults(link)
            path.chmod(0o666)
            with self.assertRaises(ValueError):
                module.read_defaults(path)

    def test_malformed_and_oversized_configuration_refused(self):
        with tempfile.TemporaryDirectory() as root:
            for source in ["_DEFAULT_CLIENT_ID=__import__('os').getenv('HOME')", 'x' * 65537, "_DEFAULT_CLIENT_ID='other.example'\n_DEFAULT_CLIENT_SECRET='synthetic'\n_DEFAULT_SCOPES=['openid']"]:
                with self.assertRaises((ValueError, KeyError)):
                    module.read_defaults(self.make(root, source))


if __name__ == '__main__':
    unittest.main()
