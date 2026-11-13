import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


class ReleaseVectorTests(unittest.TestCase):
    def test_actual_release_vector_and_fail_closed_variants(self):
        source = Path(__file__).resolve().parent.parent
        relative = ['plugins/account-pool-balanced/package.json',
                    'plugins/account-pool-balanced/package-lock.json', 'marketplace.json']
        vpn_files = ['plugins/vpn-guard/package.json', 'plugins/vpn-guard/package-lock.json']
        originals = {p: json.loads((source / p).read_text()) for p in relative + vpn_files}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def git(*args):
                p = subprocess.run(['git', *args], cwd=root, capture_output=True, text=True, timeout=20)
                if p.returncode:
                    raise RuntimeError(p.stderr)
                return p.stdout.strip()
            git('init', '-q')
            (root / '.gitignore').write_text('.gh-account\noutput\n')
            if (source / '.gh-account').exists():
                (root / '.gh-account').write_bytes((source / '.gh-account').read_bytes())
            def write(docs):
                for rel, data in docs.items():
                    p = root / rel
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(json.dumps(data))
            def commit():
                git('add', '-A')
                git('-c', 'user.name=Synthetic', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture')
                return git('rev-parse', 'HEAD')
            write(originals)
            ui = root / 'plugins/account-pool-balanced/app.tsx'
            ui.write_text('// initial fixture\n')
            base = commit()
            git('tag', 'account-pool-balanced/v0.4.87')
            for case in ['version', 'dependency', 'lock', 'inventory', 'unknown', 'deleted', 'malformed', 'duplicate', 'wrong-path', 'other-plugin', 'schema-type', 'field-type', 'other-metadata-only']:
                with self.subTest(case=case):
                    docs = copy.deepcopy(originals)
                    package, lock, market = (docs[p] for p in relative)
                    package['version'] = lock['version'] = lock['packages']['']['version'] = '0.4.88'
                    next(p for p in market['plugins'] if p['id'] == 'account-pool-balanced')['source']['git']['range'] = '^0.4.88'
                    if case == 'schema-type':
                        market['schemaVersion'] = True
                    if case == 'field-type':
                        package['private'] = 1
                    if case == 'dependency':
                        package['dependencies']['new-synthetic-dependency'] = '1.0.0'
                    if case == 'lock':
                        lock['packages']['node_modules/synthetic'] = {'version': '1.0.0'}
                    if case == 'inventory':
                        market['plugins'].pop()
                    if case == 'unknown':
                        package['newField'] = True
                    if case == 'other-metadata-only':
                        docs = copy.deepcopy(originals)
                        docs[vpn_files[0]]['version'] = '0.0.99'
                        docs[vpn_files[1]]['version'] = '0.0.99'
                        docs[vpn_files[1]]['packages']['']['version'] = '0.0.99'
                        next(p for p in docs['marketplace.json']['plugins'] if p['id'] == 'vpn-guard')['source']['git']['range'] = '^0.0.99'
                    write(docs)
                    ui.write_text('// initial fixture\n' if case == 'other-metadata-only' else '// changed ' + case + '\n')
                    package_file = root / relative[0]
                    if case == 'deleted':
                        package_file.unlink()
                    if case == 'malformed':
                        package_file.write_text('{broken')
                    if case == 'duplicate':
                        package_file.write_text('{"version":"0.4.88","version":"0.4.88"}')
                    if case == 'wrong-path':
                        wrong = root / '.claude-plugin/marketplace.json'
                        wrong.parent.mkdir(exist_ok=True)
                        wrong.write_text('{}')
                    if case == 'other-plugin':
                        other = root / 'plugins/vpn-guard/app.tsx'
                        other.parent.mkdir(parents=True, exist_ok=True)
                        other.write_text('// fixture')
                    head = commit()
                    output = root / 'output'
                    for event in (['pull_request', 'push'] if case == 'version' else ['pull_request']):
                        if event == 'push':
                            git('tag', 'account-pool-balanced/v0.4.88')
                        output.write_text('')
                        subprocess.run(['python3', str(source / 'scripts/ci_plan.py')], cwd=root,
                                       env={**os.environ, 'EVENT_NAME': event, 'DIFF_BASE': base,
                                            'DIFF_HEAD': head, 'GITHUB_OUTPUT': str(output),
                                            'GIT_REF': 'refs/tags/account-pool-balanced/v0.4.88'},
                                       check=True, capture_output=True, timeout=30)
                        plan = {k: json.loads(v) for k, v in (line.split('=', 1) for line in output.read_text().splitlines())}
                        expected = 1 if case == 'version' else 14
                        self.assertEqual(len(plan['matrix']['include']), expected)
                        self.assertEqual(plan['upgrade_mac'], case != 'version')
                        if case == 'version':
                            self.assertEqual(plan['matrix']['include'][0]['os'], 'ubuntu-latest')
                            self.assertFalse(plan['op'])
                            self.assertFalse(plan['archive'])
                    if case == 'version':
                        # The PR base may advance independently. Compare JSON at the
                        # actual merge-base, never at the current base branch tip.
                        git('checkout', '--detach', base)
                        diverged = copy.deepcopy(originals)
                        diverged[relative[0]]['baseBranchOnlyField'] = True
                        write(diverged)
                        side = commit()
                        output.write_text('')
                        subprocess.run(['python3', str(source / 'scripts/ci_plan.py')], cwd=root,
                                       env={**os.environ, 'EVENT_NAME': 'pull_request',
                                            'DIFF_BASE': side, 'DIFF_HEAD': head,
                                            'GITHUB_OUTPUT': str(output)},
                                       check=True, capture_output=True, timeout=30)
                        result = dict(line.split('=', 1) for line in output.read_text().splitlines())
                        self.assertEqual(len(json.loads(result['matrix'])['include']), 1)
                    # Branch from the original base; each case is a fresh release diff.
                    git('checkout', '--detach', base)
